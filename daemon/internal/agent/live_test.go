package agent

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/claude"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

// TestLive drives a real claude through the manager: a turn with a
// permission prompt, then a resume after the process is stopped. It spends a
// few cents of the logged-in account's usage.
//
//	EW_CLAUDE_LIVE=1 go test ./internal/agent -run Live -v
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

	m := NewManager(st, t.TempDir(), func() {})
	defer m.Shutdown()
	realStart := m.start
	m.start = func(ctx context.Context, o claude.Options) (process, error) {
		// Keep the user's allow rules from pre-approving the tool.
		o.Args = append(o.Args, "--setting-sources=project")
		return realStart(ctx, o)
	}

	c := &fakeClient{}
	if err := m.Attach(th.ID, c, 0, 0); err != nil {
		t.Fatal(err)
	}
	wait := func(what string, cond func(protocol.AgentState) bool) protocol.AgentState {
		t.Helper()
		for deadline := time.Now().Add(2 * time.Minute); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
			if s := c.state(); cond(s) {
				return s
			}
		}
		t.Fatalf("timed out waiting for %s; state %+v, events %s, errors %v", what, c.state(), eventTypes(c.events()), c.errors())
		return protocol.AgentState{}
	}

	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "send", Text: "Use the Write tool to create notes.txt containing: remember the llama. Then reply with the single word done."})
	s := wait("permission prompt", func(s protocol.AgentState) bool { return len(s.Pending) > 0 })
	if s.Pending[0].ToolName != "Write" {
		t.Fatalf("pending = %+v", s.Pending[0])
	}
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "respond", RequestID: s.Pending[0].ID, Decision: "allow"})
	s = wait("turn to finish", func(s protocol.AgentState) bool { return s.Status == "idle" })
	got := eventTypes(c.events())
	t.Logf("events: %s", got)
	for _, want := range []string{"turn:started", "user", "tool", "request:allow", "toolResult", "assistant", "turn:completed"} {
		if !strings.Contains(got, want) {
			t.Errorf("events missing %q", want)
		}
	}
	if b, err := os.ReadFile(filepath.Join(dir, "notes.txt")); err != nil || !strings.Contains(string(b), "llama") {
		t.Fatalf("notes.txt = %q, %v", b, err)
	}
	if s.SessionID == "" || s.Account == nil || len(s.Models) == 0 {
		t.Fatalf("state missing session/account/models: %+v", s)
	}
	// claude names the thread; the prompt's first line was only a stand-in.
	stand := "Use the Write tool to create notes.txt containing: remember the…"
	var name string
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		if t, _ := st.GetThread(th.ID); t.Name != stand && !defaultThreadName.MatchString(t.Name) {
			name = t.Name
			break
		}
	}
	t.Logf("title: %q", name)
	if name == "" {
		t.Error("claude didn't name the thread")
	}

	// Stop the process as the idle reaper would; the next prompt resumes.
	m.mu.Lock()
	sess := m.sessions[th.ID]
	m.mu.Unlock()
	sess.do(func() { sess.closeProc() })
	wait("stop", func(s protocol.AgentState) bool { return s.Status == "stopped" })

	before := len(c.events())
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "send", Text: "What animal did the file mention? Reply with one word."})
	wait("resumed turn", func(s protocol.AgentState) bool { return s.Status == "idle" && len(c.events()) > before+2 })
	var answer string
	for _, e := range c.events()[before:] {
		if e.Type == "assistant" {
			answer += e.Text
		}
	}
	if !strings.Contains(strings.ToLower(answer), "llama") {
		t.Fatalf("resumed session answered %q", answer)
	}
	if c.state().SessionID != s.SessionID {
		t.Fatalf("session changed on resume: %q -> %q", s.SessionID, c.state().SessionID)
	}
}

// TestLiveRewind rolls a real claude back past a turn that edited a file:
// the file is restored and the resumed conversation doesn't know the turn.
//
//	EW_CLAUDE_LIVE=1 go test ./internal/agent -run LiveRewind -v
func TestLiveRewind(t *testing.T) {
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
	_ = st.SetAgentModel(th.ID, "haiku")
	_ = st.SetAgentPermissionMode(th.ID, "bypassPermissions")
	m := NewManager(st, t.TempDir(), func() {})
	defer m.Shutdown()

	c := &fakeClient{}
	if err := m.Attach(th.ID, c, 0, 0); err != nil {
		t.Fatal(err)
	}
	turn := func(text string) string {
		t.Helper()
		before := strings.Count(eventTypes(c.events()), "turn:completed")
		m.Handle(th.ID, c, protocol.AgentClientMsg{T: "send", Text: text})
		for deadline := time.Now().Add(2 * time.Minute); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
			evs := c.events()
			if strings.Count(eventTypes(evs), "turn:completed") > before {
				for i := len(evs) - 1; i >= 0; i-- {
					if evs[i].Type == "user" {
						return evs[i].ID
					}
				}
			}
		}
		t.Fatalf("turn %q didn't finish: %s %v", text, eventTypes(c.events()), c.errors())
		return ""
	}
	notes := filepath.Join(dir, "notes.txt")
	turn("Use the Write tool to create notes.txt containing exactly: llama. Then reply with the single word done.")
	second := turn("Read notes.txt, then use the Write tool to replace its contents with exactly: zebra. Then reply done.")
	if b, _ := os.ReadFile(notes); !strings.Contains(string(b), "zebra") {
		t.Fatalf("notes.txt after the second turn = %q", b)
	}
	session := c.state().SessionID

	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "rewind", ID: second, Files: true})
	for deadline := time.Now().Add(time.Minute); ; time.Sleep(50 * time.Millisecond) {
		evs := c.events()
		if len(c.errors()) > 0 || time.Now().After(deadline) {
			t.Fatalf("rewind: %v; events %s", c.errors(), eventTypes(evs))
		}
		if e := evs[len(evs)-1]; e.Type == "rewind" {
			t.Logf("rewind: %+v", e)
			break
		}
	}
	if b, _ := os.ReadFile(notes); strings.TrimSpace(string(b)) != "llama" {
		t.Fatalf("notes.txt after the rewind = %q", b)
	}

	turn("Without using any tools: which words have I asked you to write to notes.txt in this conversation? Answer in one line.")
	var answer string
	evs := c.events()
	for i := len(evs) - 1; i >= 0 && evs[i].Type != "user"; i-- {
		if evs[i].Type == "assistant" {
			answer = evs[i].Text + answer
		}
	}
	t.Logf("answer: %q", answer)
	if a := strings.ToLower(answer); !strings.Contains(a, "llama") || strings.Contains(a, "zebra") {
		t.Fatalf("the forked conversation answered %q", answer)
	}
	if s := c.state().SessionID; s == "" || s == session {
		t.Fatalf("session %q after the rewind, was %q", s, session)
	}
}
