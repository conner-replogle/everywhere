package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

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
	if s.Harness == nil || s.Harness.Kind != "fake" || s.Harness.Version != "9.9" || len(s.Models) != 2 || len(s.Modes) != 3 || s.PermissionMode != "build" {
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
	eventually(t, "the probed config", func() bool { s := c.state(); return len(s.Models) == 2 && len(s.Modes) == 3 })
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

// Another agent is signed in from the app: its sign-in command's link, then
// the code from its page. Until it is, its threads say how to sign it in.
func TestHarnessSignIn(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "signed-in")
	t.Setenv(acptest.Env, "1")
	t.Setenv(acptest.AuthEnv, marker)
	saved := harness.Agents
	harness.Agents = []harness.Agent{{
		Kind: "fake", Title: "Fake", Command: []string{exe}, Install: "Sign it in.",
		Login: []string{"/usr/bin/env", acptest.LoginEnv + "=" + marker, exe}, LoginPrompt: acptest.LoginPrompt,
	}}
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
	t.Cleanup(m.Shutdown)
	ctx := context.Background()

	a, err := m.HarnessAuth(ctx, "fake")
	if err != nil || !a.Installed || !a.Known || a.SignedIn || !a.CanSignIn || a.Title != "Fake" {
		t.Fatalf("before signing in: %+v, %v", a, err)
	}
	c := &recorder{}
	if err := m.Attach(th.ID, c, 0, 0); err != nil {
		t.Fatal(err)
	}
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "send", Text: "hello"})
	eventually(t, "the sign-in error", func() bool {
		errs := c.errors()
		return len(errs) > 0 && strings.Contains(errs[len(errs)-1], "Fake isn't signed in. Sign it in.")
	})

	// A code the page didn't give is refused, in the CLI's words.
	l, err := m.StartHarnessLogin(ctx, "fake")
	if err != nil || !strings.HasPrefix(l.URL, "https://") || !strings.Contains(l.URL, "oauth") {
		t.Fatalf("sign-in link %q, %v", l.URL, err)
	}
	if a, _ := m.HarnessAuth(ctx, "fake"); !a.SigningIn {
		t.Fatalf("while waiting for the code: %+v", a)
	}
	if _, err := m.FinishHarnessLogin(ctx, "fake", "wrong"); err == nil || !strings.Contains(err.Error(), "that code was refused") {
		t.Fatalf("a wrong code: %v", err)
	}
	if _, err := m.FinishHarnessLogin(ctx, "fake", acptest.GoodCode); err == nil {
		t.Fatal("a code for a sign-in that ended was taken")
	}

	// Cancelled, it stops waiting.
	if _, err := m.StartHarnessLogin(ctx, "fake"); err != nil {
		t.Fatal(err)
	}
	m.CancelHarnessLogin("fake")
	if a, _ := m.HarnessAuth(ctx, "fake"); a.SigningIn || a.SignedIn {
		t.Fatalf("after cancelling: %+v", a)
	}

	// The right code signs it in, and its threads work.
	if _, err := m.StartHarnessLogin(ctx, "fake"); err != nil {
		t.Fatal(err)
	}
	a, err = m.FinishHarnessLogin(ctx, "fake", " "+acptest.GoodCode+"\n")
	if err != nil || !a.SignedIn || a.SigningIn {
		t.Fatalf("signed in: %+v, %v", a, err)
	}
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "send", Text: "hello"})
	eventually(t, "the agent at work", func() bool { return len(c.state().Pending) == 1 })

	if _, err := m.StartHarnessLogin(ctx, "nope"); err == nil {
		t.Fatal("signed in an agent there isn't")
	}
}

// Another agent's own modes are its thread's, even named like claude's
// (Antigravity has an auto): a Scratch thread doesn't start in claude's auto,
// and the agent's auto, chosen, is kept when the agent starts again.
func TestHarnessModesNamedLikeClaudes(t *testing.T) {
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
	scratch, err := st.ScratchProject()
	if err != nil {
		t.Fatal(err)
	}
	th, err := st.CreateThread(scratch.ID, "", "fake")
	if err != nil {
		t.Fatal(err)
	}
	if a, _ := st.AgentThread(th.ID); a.PermissionMode != "" {
		t.Fatalf("a new Scratch thread of another agent starts in %q, claude's", a.PermissionMode)
	}
	m := NewManager(st, t.TempDir(), func() {})
	t.Cleanup(m.Shutdown)
	c := &recorder{}
	if err := m.Attach(th.ID, c, 0, 0); err != nil {
		t.Fatal(err)
	}
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "send", Text: "please write b.txt now"})
	eventually(t, "the agent's own default", func() bool { return c.state().PermissionMode == "build" && len(c.state().Pending) == 1 })
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "respond", RequestID: c.state().Pending[0].ID, Decision: "deny"})
	eventually(t, "the turn to end", lastTurnEnded(c))
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "setMode", Mode: "auto"})
	eventually(t, "auto", func() bool { return c.state().PermissionMode == "auto" })

	// Started again, it's in auto still.
	m.Kill(th.ID)
	c2 := &recorder{}
	if err := m.Attach(th.ID, c2, 0, 0); err != nil {
		t.Fatal(err)
	}
	eventually(t, "auto before it starts again", func() bool { return c2.state().PermissionMode == "auto" })
	m.Handle(th.ID, c2, protocol.AgentClientMsg{T: "send", Text: "please write c.txt now"})
	eventually(t, "the agent at work again", func() bool { return len(c2.state().Pending) == 1 })
	if s := c2.state(); s.PermissionMode != "auto" {
		t.Fatalf("started again in %q", s.PermissionMode)
	}
	if a, _ := st.AgentThread(th.ID); a.PermissionMode != "auto" {
		t.Fatalf("kept %q", a.PermissionMode)
	}
	m.Handle(th.ID, c2, protocol.AgentClientMsg{T: "respond", RequestID: c2.state().Pending[0].ID, Decision: "deny"})
	eventually(t, "the second turn to end", lastTurnEnded(c2))

	// A mode of claude's kept from before is no mode of the agent's.
	m.Kill(th.ID)
	if err := st.SetAgentPermissionMode(th.ID, "bypassPermissions"); err != nil {
		t.Fatal(err)
	}
	c3 := &recorder{}
	if err := m.Attach(th.ID, c3, 0, 0); err != nil {
		t.Fatal(err)
	}
	eventually(t, "one of the agent's modes over claude's", func() bool {
		s := c3.state()
		return len(s.Modes) == 3 && s.PermissionMode != "" && s.PermissionMode != "bypassPermissions"
	})
}

// Where an agent has no auto mode, everywhere's Accept all stands in for it:
// the agent runs in its own mode for that, and its requests are approved
// without asking, before and after it starts again. With an auto, there's
// none.
func TestHarnessAcceptAll(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(acptest.Env, "1")
	t.Setenv(acptest.NoAutoEnv, "1")
	saved := harness.Agents
	harness.Agents = []harness.Agent{{Kind: "fake", Title: "Fake", Command: []string{exe}, AcceptAll: "plan"}}
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
	t.Cleanup(m.Shutdown)
	c := &recorder{}
	if err := m.Attach(th.ID, c, 0, 0); err != nil {
		t.Fatal(err)
	}
	offers := func(s protocol.AgentState, mode string) bool {
		return slices.ContainsFunc(s.Modes, func(m protocol.AgentMode) bool { return m.Value == mode })
	}
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "send", Text: "please write a.txt now"})
	eventually(t, "the first request", func() bool { return len(c.state().Pending) == 1 })
	if s := c.state(); !offers(s, harness.AcceptAllMode) || offers(s, "auto") || len(s.Modes) != 3 {
		t.Fatalf("modes %+v", s.Modes)
	}
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "respond", RequestID: c.state().Pending[0].ID, Decision: "deny"})
	eventually(t, "the first turn", lastTurnEnded(c))

	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "setMode", Mode: harness.AcceptAllMode})
	eventually(t, "accept all", func() bool { return c.state().PermissionMode == harness.AcceptAllMode })
	before := len(c.events())
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "send", Text: "please write b.txt now"})
	eventually(t, "the second turn", func() bool { return len(c.events()) > before+2 && lastTurnEnded(c)() })
	got := strings.Join(summary(c.events(), before), "|")
	if strings.Contains(got, "request:") || !strings.Contains(got, "tool:Write|result:false:Wrote file successfully.") {
		t.Fatalf("approved without asking? %s", got)
	}
	if s := c.state(); s.PermissionMode != harness.AcceptAllMode || len(s.Pending) != 0 {
		t.Fatalf("after: %+v", s)
	}

	// Started again, it accepts all still.
	m.Kill(th.ID)
	c2 := &recorder{}
	if err := m.Attach(th.ID, c2, 0, 0); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the replay", func() bool { return len(c2.events()) > 0 })
	before = len(c2.events())
	m.Handle(th.ID, c2, protocol.AgentClientMsg{T: "send", Text: "please write c.txt now"})
	eventually(t, "the third turn", func() bool { return len(c2.events()) > before+2 && lastTurnEnded(c2)() })
	if got := strings.Join(summary(c2.events(), before), "|"); strings.Contains(got, "request:") {
		t.Fatalf("asked after starting again: %s", got)
	}
	if s := c2.state(); s.PermissionMode != harness.AcceptAllMode {
		t.Fatalf("started again in %q", s.PermissionMode)
	}

	// An agent with an auto of its own has no Accept all.
	m.Kill(th.ID)
	t.Setenv(acptest.NoAutoEnv, "")
	if err := st.SetAgentPermissionMode(th.ID, ""); err != nil {
		t.Fatal(err)
	}
	c3 := &recorder{}
	if err := m.Attach(th.ID, c3, 0, 0); err != nil {
		t.Fatal(err)
	}
	m.Handle(th.ID, c3, protocol.AgentClientMsg{T: "send", Text: "please write d.txt now"})
	eventually(t, "a request with auto offered", func() bool { return len(c3.state().Pending) == 1 })
	if s := c3.state(); offers(s, harness.AcceptAllMode) || !offers(s, "auto") {
		t.Fatalf("modes with auto: %+v", s.Modes)
	}
}

// A message sent while another agent works (it takes one prompt at a time)
// is passed on once the prompt before it is done, in the same turn.
func TestHarnessMessageWhileWorking(t *testing.T) {
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
	t.Cleanup(m.Shutdown)
	c := &recorder{}
	if err := m.Attach(th.ID, c, 0, 0); err != nil {
		t.Fatal(err)
	}
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "send", Text: "please write a.txt now"})
	eventually(t, "the first request", func() bool { return len(c.state().Pending) == 1 })
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "send", Text: "then write b.txt"})
	eventually(t, "the second message logged", func() bool {
		return strings.Contains(strings.Join(summary(c.events(), 0), "|"), "user:then write b.txt:0")
	})
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "respond", RequestID: c.state().Pending[0].ID, Decision: "allow"})
	// The second prompt runs, in the same turn.
	eventually(t, "the second request", func() bool {
		s := c.state()
		return len(s.Pending) == 1 && strings.Count(strings.Join(summary(c.events(), 0), "|"), "request:") == 1
	})
	if s := c.state(); s.Status != statusWaiting {
		t.Fatalf("between the prompts: %s", s.Status)
	}
	m.Handle(th.ID, c, protocol.AgentClientMsg{T: "respond", RequestID: c.state().Pending[0].ID, Decision: "allow"})
	eventually(t, "the turn to end", lastTurnEnded(c))
	got := strings.Join(summary(c.events(), 0), "|")
	if strings.Count(got, "turn:started") != 1 || strings.Count(got, "turn:completed") != 1 || strings.Count(got, "tool:Write") != 2 {
		t.Fatalf("events: %s", got)
	}
	eventually(t, "idle", func() bool { return c.state().Status == statusIdle })
}

// An agent that takes MCP servers over HTTP without saying so (Antigravity)
// gets the daemon's all the same, when it's known to (MCPOverHTTP); one
// that doesn't say so, and isn't known to, gets none.
func TestHarnessMCPOverHTTPUnannounced(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	got := filepath.Join(t.TempDir(), "servers.json")
	t.Setenv(acptest.Env, "1")
	t.Setenv(acptest.NoHTTPMCPEnv, got)
	servers := []harness.MCPServer{{Name: "everywhere", URL: "http://127.0.0.1:1/mcp", Headers: map[string]string{"Authorization": "Bearer t"}}}
	for _, known := range []bool{true, false} {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		a := harness.Agent{Kind: "fake", Title: "Fake", Command: []string{exe}, MCPOverHTTP: known}
		c, err := harness.Start(ctx, harness.StartOptions{Agent: a, Dir: t.TempDir(), MCP: servers})
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		c.Close()
		raw, _ := os.ReadFile(got)
		var list []struct {
			Type, Name, URL string
			Headers         []struct{ Name, Value string }
		}
		_ = json.Unmarshal(raw, &list)
		if known && (len(list) != 1 || list[0].Type != "http" || list[0].URL != servers[0].URL || len(list[0].Headers) != 1) {
			t.Fatalf("known to take them, it got %s", raw)
		}
		if !known && len(list) != 0 {
			t.Fatalf("not known to, it got %s", raw)
		}
	}
}

// antigravityLike runs a thread of a fake agent that works as Antigravity
// does: on after its prompt, waking on its own, steered by prompts sent
// mid-turn. The waits are short.
func antigravityLike(t *testing.T) (*Manager, string, *recorder) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(acptest.Env, "1")
	saved, quiet, stop := harness.Agents, harness.SettleQuiet, harness.StopTimeout
	harness.Agents = []harness.Agent{{Kind: "fake", Title: "Fake", Command: []string{exe}, BackgroundWork: true, SteersSince: "1.0"}}
	harness.SettleQuiet, harness.StopTimeout = 150*time.Millisecond, 500*time.Millisecond
	t.Cleanup(func() { harness.Agents, harness.SettleQuiet, harness.StopTimeout = saved, quiet, stop })

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
	t.Cleanup(m.Shutdown)
	c := &recorder{}
	if err := m.Attach(th.ID, c, 0, 0); err != nil {
		t.Fatal(err)
	}
	return m, th.ID, c
}

func count(evs []string, prefix string) int {
	n := 0
	for _, e := range evs {
		if strings.HasPrefix(e, prefix) {
			n++
		}
	}
	return n
}

// A message sent mid-turn steers the agent at once: the prompt running
// ends, and the turn goes on under the new one, ending once.
func TestHarnessSteer(t *testing.T) {
	m, th, c := antigravityLike(t)
	m.Handle(th, c, protocol.AgentClientMsg{T: "send", Text: "slow work"})
	eventually(t, "it working", func() bool { return c.state().Status == statusWorking })
	time.Sleep(100 * time.Millisecond) // its prompt is in
	m.Handle(th, c, protocol.AgentClientMsg{T: "send", Text: "please write b.txt now"})
	eventually(t, "the steer's request", func() bool { return len(c.state().Pending) == 1 })
	if got := summary(c.events(), 0); count(got, "turn:") != 1 {
		t.Fatalf("the steered prompt ended the turn: %q", got)
	}
	m.Handle(th, c, protocol.AgentClientMsg{T: "respond", RequestID: c.state().Pending[0].ID, Decision: "allow"})
	eventually(t, "the turn to end", lastTurnEnded(c))
	got := summary(c.events(), 0)
	if count(got, "turn:started") != 1 || count(got, "turn:completed") != 1 || count(got, "user:") != 2 {
		t.Fatalf("events %q", got)
	}
}

// A command it leaves running holds the turn: it ends once the command
// has, and what the agent said of it is in the turn.
func TestHarnessBackgroundWork(t *testing.T) {
	m, th, c := antigravityLike(t)
	m.Handle(th, c, protocol.AgentClientMsg{T: "send", Text: "background job"})
	eventually(t, "the turn to end", lastTurnEnded(c))
	got := summary(c.events(), 0)
	joined := strings.Join(got, "|")
	if count(got, "turn:started") != 1 || count(got, "turn:completed") != 1 ||
		!strings.Contains(joined, "tool:Bash|result:false:slept|assistant:background done|turn:completed") {
		t.Fatalf("events %q", got)
	}
}

// Woken on its own, with no prompt open, it gets a turn of its own.
func TestHarnessWake(t *testing.T) {
	m, th, c := antigravityLike(t)
	m.Handle(th, c, protocol.AgentClientMsg{T: "send", Text: "wake me"})
	eventually(t, "the woken turn to end", func() bool {
		got := summary(c.events(), 0)
		return count(got, "turn:completed") == 2
	})
	got := summary(c.events(), 0)
	if count(got, "turn:started") != 2 || !strings.Contains(strings.Join(got, "|"), "turn:started|assistant:woke up|turn:completed") {
		t.Fatalf("events %q", got)
	}
	eventually(t, "idle", func() bool { return c.state().Status == statusIdle })
}

// Stop ends the turn; an agent that ignores the cancel is stopped, and the
// next prompt starts it again.
func TestHarnessStopUnresponsive(t *testing.T) {
	m, th, c := antigravityLike(t)
	m.Handle(th, c, protocol.AgentClientMsg{T: "send", Text: "stuck work"})
	eventually(t, "it working", func() bool { return c.state().Status == statusWorking })
	time.Sleep(100 * time.Millisecond) // its prompt is in
	m.Handle(th, c, protocol.AgentClientMsg{T: "interrupt"})
	eventually(t, "the turn to end", lastTurnEnded(c))
	if got := summary(c.events(), 0); got[len(got)-1] != "turn:interrupted" {
		t.Fatalf("events %q", got)
	}
	m.Handle(th, c, protocol.AgentClientMsg{T: "send", Text: "please write c.txt now"})
	eventually(t, "it working again", func() bool { return len(c.state().Pending) == 1 })
}

// Stop while a command it left running holds the turn ends the turn there
// (and session/cancel ends the command).
func TestHarnessStopBackground(t *testing.T) {
	m, th, c := antigravityLike(t)
	harness.SettleQuiet = 5 * time.Second
	m.Handle(th, c, protocol.AgentClientMsg{T: "send", Text: "wake me"})
	eventually(t, "the prompt's reply", func() bool {
		return strings.Contains(strings.Join(summary(c.events(), 0), "|"), "assistant:Going to sleep")
	})
	time.Sleep(50 * time.Millisecond) // its prompt has returned; the turn is held
	m.Handle(th, c, protocol.AgentClientMsg{T: "interrupt"})
	eventually(t, "the turn to end", lastTurnEnded(c))
	time.Sleep(500 * time.Millisecond) // the stopped run's waking is dropped
	got := summary(c.events(), 0)
	if count(got, "turn:started") != 1 || got[len(got)-1] != "turn:interrupted" || strings.Contains(strings.Join(got, "|"), "woke up") {
		t.Fatalf("events %q", got)
	}
}
