//go:build !windows

package process_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/agent"
	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
	"github.com/conner-replogle/everywhere/daemon/internal/process"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

// TestLive has a real claude (haiku) start processes through the MCP tools:
// a script that reports progress with ::ew lines, then a slow one with
// notify, whose exit must wake the idle thread. It spends a few cents of
// the logged-in account's usage.
//
//	EW_CLAUDE_LIVE=1 go test ./internal/process -run Live -v
func TestLive(t *testing.T) {
	if os.Getenv("EW_CLAUDE_LIVE") == "" {
		t.Skip("EW_CLAUDE_LIVE not set")
	}
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	proj, err := st.CreateProject(dir, "live")
	if err != nil {
		t.Fatal(err)
	}
	th, _ := st.CreateThread(proj.ID, "", protocol.ThreadClaude)
	if err := st.SetAgentModel(th.ID, "haiku"); err != nil {
		t.Fatal(err)
	}
	if err := st.SetAgentPermissionMode(th.ID, "bypassPermissions"); err != nil {
		t.Fatal(err)
	}

	procs := process.NewManager(st, t.TempDir())
	defer procs.Shutdown()
	procs.Workdir = func(string) (string, error) { return dir, nil }
	agents := agent.NewManager(st, t.TempDir(), func() {})
	defer agents.Shutdown()
	procs.Notify = func(threadID, agentThreadID string, n process.Notice) {
		agents.ProcessEvent(agentThreadID, n.Name, n.Text, n.Prompt, n.Wake)
	}
	srv := mcp.NewServer("everywhere", "test", process.Tools(procs))
	defer srv.Close()
	mcpDir := t.TempDir()
	agents.ThreadArgs = func(threadID, _ string) ([]string, func(), error) {
		endpoint, token, release, err := srv.Grant(mcp.Caller{ThreadID: threadID, Browser: threadID})
		if err != nil {
			return nil, nil, err
		}
		cfg, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"everywhere": map[string]any{
			"type": "http", "url": endpoint, "headers": map[string]string{"Authorization": "Bearer " + token},
		}}})
		path := filepath.Join(mcpDir, threadID+".json")
		if err := os.WriteFile(path, cfg, 0o600); err != nil {
			return nil, nil, err
		}
		return []string{"--mcp-config", path, "--setting-sources=project"}, release, nil
	}

	c := &client{}
	if err := agents.Attach(th.ID, c, 0, 0); err != nil {
		t.Fatal(err)
	}
	turns := func() int {
		n := 0
		for _, e := range c.events() {
			if e.Type == "turn" && e.Status != "started" {
				n++
			}
		}
		return n
	}
	waitTurns := func(n int, what string) {
		t.Helper()
		for deadline := time.Now().Add(3 * time.Minute); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
			if turns() >= n {
				return
			}
		}
		t.Fatalf("timed out waiting for %s; events %s", what, c.summary())
	}
	send := func(text string) {
		agents.Handle(th.ID, c, protocol.AgentClientMsg{T: "send", Text: text})
	}

	send(`Use the mcp__everywhere__process_start tool (not Bash) to start a process named "count" with this exact command, ` +
		`declaring a stat with key "n", label "Counted" and total 5, and wait_for "exit": ` +
		`for i in 1 2 3 4 5; do echo "::ew stat n $i/5"; sleep 0.2; done; echo '::ew checkpoint "Counted"'; echo done` +
		` Then reply with the stat's final value.`)
	waitTurns(1, "the first turn")
	v, err := procs.Find(th.ID, "count")
	if err != nil {
		t.Fatalf("claude didn't start the process: %v; events %s", err, c.summary())
	}
	if v.Status != protocol.ProcessExited || len(v.Stats) != 1 || v.Stats[0].Value != 5 || len(v.Checkpoints) != 1 {
		t.Fatalf("count: %+v", v)
	}
	t.Logf("count: %s %v stats %+v", v.Status, *v.ExitCode, v.Stats)

	send(`Now use mcp__everywhere__process_start to start a process named "slow" with command "sleep 8; echo slow finished" ` +
		`and notify true, without waiting for it (timeout_s 0). End your turn right after starting it with the single word "started". ` +
		`When you're later told it finished, reply with the single word "finished".`)
	waitTurns(2, "the turn that starts slow")
	if turns() != 2 {
		t.Fatalf("an extra turn: %s", c.summary())
	}
	// The exit should start a turn by itself.
	waitTurns(3, "the turn slow's exit starts")
	evs := c.events()
	woke := -1
	for i, e := range evs {
		if e.Type == "process" && e.Name == "slow" && e.Status == "wake" {
			woke = i
		}
	}
	if woke < 0 {
		t.Fatalf("no wake event; events %s", c.summary())
	}
	t.Logf("events: %s", c.summary())
}

type client struct {
	mu  sync.Mutex
	evs []protocol.AgentEvent
}

func (c *client) Send(frame any) {
	m, ok := frame.(protocol.AgentEventMsg)
	if !ok {
		return
	}
	var e protocol.AgentEvent
	if json.Unmarshal(m.Event, &e) == nil {
		c.mu.Lock()
		c.evs = append(c.evs, e)
		c.mu.Unlock()
	}
}

func (c *client) events() []protocol.AgentEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]protocol.AgentEvent(nil), c.evs...)
}

func (c *client) summary() string {
	var parts []string
	for _, e := range c.events() {
		s := e.Type
		switch e.Type {
		case "tool":
			s += ":" + e.Name
		case "turn", "process":
			s += ":" + e.Name + e.Status
		case "assistant":
			s += ":" + strings.TrimSpace(e.Text)
		case "toolResult":
			if e.IsError {
				s += ":error:" + e.Output
			}
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, " ")
}
