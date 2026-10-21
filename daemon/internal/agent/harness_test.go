package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/conner-replogle/everywhere/daemon/internal/harness"
	"github.com/conner-replogle/everywhere/daemon/internal/harness/acptest"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

// The test binary doubles as a fake ACP agent.
func TestMain(m *testing.M) {
	acptest.Main()
	os.Exit(m.Run())
}

type recorder struct {
	mu     sync.Mutex
	frames []any
}

func (r *recorder) Send(frame any) {
	r.mu.Lock()
	r.frames = append(r.frames, frame)
	r.mu.Unlock()
}

func (r *recorder) state() protocol.AgentState {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := len(r.frames) - 1; i >= 0; i-- {
		if s, ok := r.frames[i].(protocol.AgentStateMsg); ok {
			return s.State
		}
	}
	return protocol.AgentState{}
}

// events are the logged events since the n-th.
func (r *recorder) events() []protocol.AgentEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []protocol.AgentEvent
	for _, f := range r.frames {
		if e, ok := f.(protocol.AgentEventMsg); ok {
			var ev protocol.AgentEvent
			_ = json.Unmarshal(e.Event, &ev)
			out = append(out, ev)
		}
	}
	return out
}

func (r *recorder) errors() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, f := range r.frames {
		if e, ok := f.(protocol.AgentErrorMsg); ok {
			out = append(out, e.Message)
		}
	}
	return out
}

// summary is events as short strings, from the i-th.
func summary(evs []protocol.AgentEvent, from int) []string {
	var out []string
	for _, e := range evs[from:] {
		switch e.Type {
		case "turn", "request":
			out = append(out, e.Type+":"+e.Status+e.Decision)
		case "tool":
			out = append(out, "tool:"+e.Name)
		case "toolResult":
			out = append(out, fmt.Sprintf("result:%v:%s", e.IsError, e.Output))
		case "user":
			out = append(out, fmt.Sprintf("user:%s:%d", e.Text, len(e.Attachments)))
		default:
			out = append(out, e.Type+":"+e.Text)
		}
	}
	return out
}

func lastTurnEnded(c *recorder) func() bool {
	return func() bool {
		evs := c.events()
		return len(evs) > 0 && evs[len(evs)-1].Type == "turn" && evs[len(evs)-1].Status != "started"
	}
}

// A thread of another agent runs on the same engine as claude's, through
// its ACP harness.
func TestHarnessThread(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(acptest.Env, "1")
	saved := harness.Agents
	harness.Agents = []harness.Agent{{Kind: "fake", Title: "Fake", Command: []string{exe}}}
	t.Cleanup(func() { harness.Agents = saved })

	st, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	projects, _ := st.ListProjects()
	th, err := st.CreateThread(projects[0].ID, "", "fake")
	if err != nil {
		t.Fatal(err)
	}
	m := NewManager(st, t.TempDir(), func() {})
	var nmu sync.Mutex
	var notified []string
	m.Notify = func(n protocol.HubNotify) { nmu.Lock(); notified = append(notified, n.Kind); nmu.Unlock() }
	t.Cleanup(m.Shutdown)

	c := &recorder{}
	if err := m.Attach(th.ID, c, 0, 0); err != nil {
		t.Fatal(err)
	}
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "send", Text: "please write b.txt now"})
	eventually(t, "the permission prompt", func() bool { return len(c.state().Pending) == 1 })
	s := c.state()
	if s.Harness == nil || s.Harness.Kind != "fake" || s.Harness.Version != "9.9" || len(s.Models) != 2 || len(s.Modes) != 2 || s.PermissionMode != "build" {
		t.Fatalf("state = %+v", s)
	}
	req := s.Pending[0]
	if req.ToolName != "Write" || !bytes.Contains(req.Input, []byte(`"file_path":"b.txt"`)) || !req.CanAllowSession || s.Status != statusWaiting {
		t.Fatalf("request = %+v %s, status %s", req, req.Input, s.Status)
	}
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "respond", RequestID: req.ID, Decision: "allowSession"})
	eventually(t, "the turn to end", lastTurnEnded(c))
	got := summary(c.events(), 0)
	want := []string{
		"turn:started", "user:please write b.txt now:0", "thinking:thinking it over", "assistant:I'll write the file.",
		"tool:Write", "request:allowSession", "result:false:Wrote file successfully.", "assistant:Done.", "turn:completed",
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("events:\n got %q\nwant %q", got, want)
	}
	// The state follows the turn's last event.
	eventually(t, "the state after the turn", func() bool { return c.state().Status == statusIdle })
	if s := c.state(); s.Context == nil || s.Context.Used != 50 || s.Context.Max != 1000 {
		t.Fatalf("state after the turn = %+v", s)
	}
	tt, _ := st.GetThread(th.ID)
	a, _ := st.AgentThread(th.ID)
	if tt.Name != "please write b.txt now" || a.SessionID != "s1" {
		t.Fatalf("thread %q, session %q", tt.Name, a.SessionID)
	}
	nmu.Lock()
	if strings.Join(notified, ",") != "permission,done" {
		t.Fatalf("notified %v", notified)
	}
	nmu.Unlock()

	// Settings: the agent's own modes; claude's don't apply.
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "setMode", Mode: "plan"})
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "setMode", Mode: "bypassPermissions"})
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "setModel", Model: "m2"})
	eventually(t, "the settings", func() bool { s := c.state(); return s.PermissionMode == "plan" && s.Model == "m2" })
	if errs := c.errors(); len(errs) != 1 || !strings.Contains(errs[0], `no mode "bypassPermissions"`) {
		t.Fatalf("errors %q", errs)
	}

	// After a restart the conversation is reloaded, not replayed into the log;
	// an image goes along with a prompt.
	m.Kill(th.ID)
	c2 := &recorder{}
	if err := m.Attach(th.ID, c2, 0, 0); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the replay", func() bool { return len(c2.events()) >= len(want) })
	before := len(c2.events())
	att, err := m.SaveUpload(th.ID, "abcdefgh12", "pic.png", "image/png", 4, strings.NewReader("\x89PNG"))
	if err != nil {
		t.Fatal(err)
	}
	m.Handle(th.ID, c2, protocol.AgentClientMsg{T: "send", Text: "look at this", Attachments: []string{att.ID}})
	eventually(t, "the second permission prompt", func() bool { return len(c2.state().Pending) == 1 })
	m.Handle(th.ID, c2, protocol.AgentClientMsg{T: "respond", RequestID: c2.state().Pending[0].ID, Decision: "deny"})
	eventually(t, "the second turn", lastTurnEnded(c2))
	got = summary(c2.events(), before)
	want = []string{
		"turn:started", "user:look at this:1", "thinking:thinking it over", "assistant:I see an image. I'll write the file.",
		"tool:Write", "request:deny", "result:true:Rejected.", "assistant:Done.", "turn:completed",
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("after reload:\n got %q\nwant %q", got, want)
	}

	// Stopping a turn.
	before = len(c2.events())
	m.Handle(th.ID, c2, protocol.AgentClientMsg{T: "send", Text: "something slow"})
	eventually(t, "the slow turn", func() bool { return c2.state().Status == statusWorking })
	m.Handle(th.ID, c2, protocol.AgentClientMsg{T: "interrupt"})
	eventually(t, "the interrupted turn", func() bool { return len(c2.events()) > before+1 && lastTurnEnded(c2)() })
	evs := c2.events()
	if last := evs[len(evs)-1]; last.Status != "interrupted" {
		t.Fatalf("after interrupt: %q", summary(evs, before))
	}
	// Claude's controls aren't the agent's.
	if err := m.Request(th.ID, protocol.AgentClientMsg{T: "setEffort", Effort: "high"}); err == nil {
		t.Fatal("setEffort worked")
	}
	eventually(t, "the thread's status", func() bool { running, status := m.Status(th.ID); return running && status == statusIdle })
}

// A thread that hasn't started offers its agent's models and modes: probed
// once per kind, without a prompt, and kept for the next daemon.
func TestAgentConfigBeforeStart(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(acptest.Env, "1")
	saved := harness.Agents
	harness.Agents = []harness.Agent{{Kind: "fake", Title: "Fake", Command: []string{exe}}}
	t.Cleanup(func() { harness.Agents = saved })

	st, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	projects, _ := st.ListProjects()
	th, err := st.CreateThread(projects[0].ID, "", "fake")
	if err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	m := NewManager(st, dataDir, func() {})
	c := &recorder{}
	if err := m.Attach(th.ID, c, 0, 0); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the probed config", func() bool { s := c.state(); return len(s.Models) == 2 && len(s.Modes) == 2 })
	s := c.state()
	if s.Status != statusStopped || s.PermissionMode != "build" || len(c.events()) != 0 {
		t.Fatalf("state %+v, events %v", s, c.events())
	}
	// A model chosen now is the one it starts with.
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "setModel", Model: "m2"})
	eventually(t, "the model", func() bool { return c.state().Model == "m2" })
	m.Shutdown()

	m2 := NewManager(st, dataDir, func() {})
	t.Cleanup(m2.Shutdown)
	m2.startAgent = func(context.Context, harness.StartOptions) (process, error) { return nil, errors.New("no probe") }
	c2 := &recorder{}
	if err := m2.Attach(th.ID, c2, 0, 0); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the saved config", func() bool { s := c2.state(); return len(s.Models) == 2 && s.Model == "m2" })
}
