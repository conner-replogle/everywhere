package agent

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/claude"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

// fakeProc is a scripted claude process: tests push CLI output with emit and
// inspect what the session sent it.
type fakeProc struct {
	opts claude.Options
	msgs chan claude.Message

	mu         sync.Mutex
	sent       []claude.UserMessage
	responses  []claude.PermissionResult
	interrupts int
	modes      []string
	closed     bool
	exitErr    error
}

func (p *fakeProc) Messages() <-chan claude.Message { return p.msgs }
func (p *fakeProc) Init() claude.InitResponse {
	return claude.InitResponse{
		Account: claude.Account{Email: "me@example.com"},
		Models:  []claude.Model{{Value: "default", DisplayName: "Default"}},
	}
}
func (p *fakeProc) Err() error { p.mu.Lock(); defer p.mu.Unlock(); return p.exitErr }
func (p *fakeProc) Send(m claude.UserMessage) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sent = append(p.sent, m)
	return nil
}
func (p *fakeProc) Respond(_ *claude.PermissionRequest, r claude.PermissionResult) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.responses = append(p.responses, r)
	return nil
}
func (p *fakeProc) Interrupt(context.Context) error {
	p.mu.Lock()
	p.interrupts++
	p.mu.Unlock()
	p.emit(`{"type":"result","subtype":"error_during_execution","is_error":true}`)
	return nil
}
func (p *fakeProc) SetPermissionMode(_ context.Context, mode string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.modes = append(p.modes, mode)
	return nil
}
func (p *fakeProc) SetModel(context.Context, string) error { return nil }
func (p *fakeProc) Close()                                 { p.exit(nil) }

func (p *fakeProc) exit(err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.closed {
		p.closed, p.exitErr = true, err
		close(p.msgs)
	}
}

// emit feeds one frame of CLI output, decoded the way the claude package
// would.
func (p *fakeProc) emit(frame string) {
	var m claude.Message
	if err := json.Unmarshal([]byte(frame), &m); err != nil {
		panic(err)
	}
	m.Raw = json.RawMessage(frame)
	if m.Type == "control_request" {
		var f struct {
			RequestID string                   `json:"request_id"`
			Request   claude.PermissionRequest `json:"request"`
		}
		_ = json.Unmarshal(m.Raw, &f)
		f.Request.ID = f.RequestID
		m.Permission = &f.Request
	}
	if m.Type == "control_cancel_request" {
		var f struct {
			RequestID string `json:"request_id"`
		}
		_ = json.Unmarshal(m.Raw, &f)
		m.CanceledRequestID = f.RequestID
	}
	p.msgs <- m
}

// fakeClient records frames.
type fakeClient struct {
	mu     sync.Mutex
	frames []any
}

func (c *fakeClient) Send(frame any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.frames = append(c.frames, frame)
}

func (c *fakeClient) events() []protocol.AgentEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []protocol.AgentEvent
	for _, f := range c.frames {
		if e, ok := f.(protocol.AgentEventMsg); ok {
			var ev protocol.AgentEvent
			_ = json.Unmarshal(e.Event, &ev)
			out = append(out, ev)
		}
	}
	return out
}

func (c *fakeClient) state() protocol.AgentState {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := len(c.frames) - 1; i >= 0; i-- {
		if s, ok := c.frames[i].(protocol.AgentStateMsg); ok {
			return s.State
		}
	}
	return protocol.AgentState{}
}

func (c *fakeClient) deltas() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var parts []string
	for _, f := range c.frames {
		if d, ok := f.(protocol.AgentDeltaMsg); ok {
			parts = append(parts, d.Key+"="+d.Text)
		}
	}
	return strings.Join(parts, " ")
}

func (c *fakeClient) errors() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for _, f := range c.frames {
		if e, ok := f.(protocol.AgentErrorMsg); ok {
			out = append(out, e.Message)
		}
	}
	return out
}

func eventTypes(evs []protocol.AgentEvent) string {
	var parts []string
	for _, e := range evs {
		t := e.Type
		if e.Status != "" {
			t += ":" + e.Status
		}
		if e.Decision != "" {
			t += ":" + e.Decision
		}
		parts = append(parts, t)
	}
	return strings.Join(parts, " ")
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

type harness struct {
	t      *testing.T
	st     *store.Store
	m      *Manager
	thread string
	mu     sync.Mutex
	procs  []*fakeProc
}

func newHarness(t *testing.T) *harness {
	st, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	projects, _ := st.ListProjects()
	th, err := st.CreateThread(projects[0].ID, "", protocol.ThreadClaude)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, st: st, thread: th.ID}
	h.m = NewManager(st, func() {})
	h.m.start = func(_ context.Context, o claude.Options) (process, error) {
		p := &fakeProc{opts: o, msgs: make(chan claude.Message, 100)}
		h.mu.Lock()
		h.procs = append(h.procs, p)
		h.mu.Unlock()
		return p, nil
	}
	t.Cleanup(h.m.Shutdown)
	return h
}

func (h *harness) proc(i int) *fakeProc {
	h.t.Helper()
	eventually(h.t, "claude to start", func() bool { h.mu.Lock(); defer h.mu.Unlock(); return len(h.procs) > i })
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.procs[i]
}

func (h *harness) attach(afterSeq int64) *fakeClient {
	c := &fakeClient{}
	if err := h.m.Attach(h.thread, c, afterSeq); err != nil {
		h.t.Fatal(err)
	}
	return c
}

func (h *harness) do(c *fakeClient, msg protocol.AgentClientMsg) { h.m.Handle(h.thread, c, msg) }

func (h *harness) waitStatus(c *fakeClient, status string) {
	h.t.Helper()
	eventually(h.t, "status "+status, func() bool { return c.state().Status == status })
}

func TestTurnLifecycle(t *testing.T) {
	h := newHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "fix the bug\nin main.go"})
	p := h.proc(0)
	h.waitStatus(c, "working")
	if p.opts.Resume != "" || p.opts.PermissionMode != "default" {
		t.Fatalf("started with %+v", p.opts)
	}

	p.emit(`{"type":"system","subtype":"init","session_id":"sess-1","model":"claude-x","permissionMode":"default"}`)
	p.emit(`{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1"}}}`)
	p.emit(`{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}`)
	p.emit(`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Look"}}}`)
	p.emit(`{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ing"}}}`)
	eventually(t, "streamed text", func() bool { return c.deltas() == "msg_1:0=Look msg_1:0=ing" })
	// A client attaching mid-stream gets the text so far in its state.
	mid := h.attach(0)
	eventually(t, "mid-stream state", func() bool {
		s := mid.state()
		return len(s.Streaming) == 1 && s.Streaming[0].Text == "Looking" && s.Streaming[0].Key == "msg_1:0"
	})
	p.emit(`{"type":"assistant","uuid":"u1","message":{"id":"msg_1","content":[{"type":"text","text":"Looking"}]}}`)
	p.emit(`{"type":"assistant","uuid":"u2","message":{"id":"msg_1","content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"main.go"}}]}}`)
	p.emit(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[{"type":"text","text":"package main"}]}]}}`)
	p.emit(`{"type":"result","subtype":"success","result":"done","total_cost_usd":0.01,"duration_ms":1200}`)
	h.waitStatus(c, "idle")

	evs := c.events()
	if got := eventTypes(evs); got != "turn:started user assistant tool toolResult turn:completed" {
		t.Fatalf("events = %s", got)
	}
	if evs[2].StreamKey != "msg_1:0" || evs[3].Name != "Read" || evs[4].Output != "package main" || evs[5].CostUSD != 0.01 {
		t.Fatalf("event details: %+v", evs)
	}
	if s := c.state(); len(s.Streaming) != 0 || s.SessionID != "sess-1" || s.ActiveModel != "claude-x" || s.Account.Email != "me@example.com" {
		t.Fatalf("state = %+v", s)
	}
	if len(p.sent) != 1 || p.sent[0].UUID != evs[1].ID {
		t.Fatalf("sent %+v; the prompt's uuid should match its event id", p.sent)
	}

	// The session id and title stick.
	a, _ := h.st.AgentThread(h.thread)
	th, _ := h.st.GetThread(h.thread)
	if a.SessionID != "sess-1" || th.Name != "fix the bug" {
		t.Fatalf("stored session %q, title %q", a.SessionID, th.Name)
	}
	if running, status := h.m.Status(h.thread); !running || status != "idle" {
		t.Fatalf("Status = %v %q", running, status)
	}
}

func TestReattachReplaysAfterSeq(t *testing.T) {
	h := newHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "hi"})
	p := h.proc(0)
	p.emit(`{"type":"result","subtype":"success"}`)
	h.waitStatus(c, "idle")

	// A client that saw the first two events only gets the rest.
	late := h.attach(2)
	eventually(t, "replay", func() bool { return late.state().Status == "idle" })
	if got := eventTypes(late.events()); got != "turn:completed" {
		t.Fatalf("replayed %s", got)
	}
}

func TestPermissionPrompt(t *testing.T) {
	h := newHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "write it"})
	p := h.proc(0)
	p.emit(`{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Write","tool_use_id":"toolu_1","input":{"file_path":"a"},"permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}`)
	h.waitStatus(c, "waiting")
	req := c.state().Pending[0]
	if req.ID != "r1" || req.Kind != "tool" || !req.CanAllowSession {
		t.Fatalf("pending = %+v", req)
	}
	if running, status := h.m.Status(h.thread); !running || status != "waiting" {
		t.Fatalf("thread list would show %v %q", running, status)
	}

	// Allowing for the session applies the suggestions: here, acceptEdits.
	h.do(c, protocol.AgentClientMsg{T: "respond", RequestID: "r1", Decision: "allowSession"})
	h.waitStatus(c, "working")
	if len(p.responses) != 1 || p.responses[0].Behavior != "allow" || len(p.responses[0].UpdatedPermissions) != 1 {
		t.Fatalf("responses = %+v", p.responses)
	}
	if s := c.state(); s.PermissionMode != "acceptEdits" || len(s.Pending) != 0 {
		t.Fatalf("state = %+v", s)
	}

	// A second answer to the same request is refused.
	h.do(c, protocol.AgentClientMsg{T: "respond", RequestID: "r1", Decision: "deny"})
	eventually(t, "error", func() bool { return len(c.errors()) == 1 })
}

func TestQuestionAnswersReachTool(t *testing.T) {
	h := newHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "ask me"})
	p := h.proc(0)
	p.emit(`{"type":"control_request","request_id":"q1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"toolu_q","input":{"questions":[{"question":"Which db?","header":"DB","options":[{"label":"sqlite"},{"label":"pg"}],"multiSelect":false}]}}}`)
	h.waitStatus(c, "waiting")
	if k := c.state().Pending[0].Kind; k != "question" {
		t.Fatalf("kind = %q", k)
	}
	h.do(c, protocol.AgentClientMsg{T: "respond", RequestID: "q1", Decision: "allow", Answers: map[string]string{"Which db?": "sqlite"}})
	h.waitStatus(c, "working")
	var input struct {
		Questions []any             `json:"questions"`
		Answers   map[string]string `json:"answers"`
	}
	if err := json.Unmarshal(p.responses[0].UpdatedInput, &input); err != nil || input.Answers["Which db?"] != "sqlite" || len(input.Questions) != 1 {
		t.Fatalf("updatedInput = %s", p.responses[0].UpdatedInput)
	}
}

func TestInterrupt(t *testing.T) {
	h := newHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "long task"})
	p := h.proc(0)
	p.emit(`{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"t","input":{}}}`)
	h.waitStatus(c, "waiting")
	h.do(c, protocol.AgentClientMsg{T: "interrupt"})
	h.waitStatus(c, "idle")
	if got := eventTypes(c.events()); got != "turn:started user request:canceled turn:interrupted" {
		t.Fatalf("events = %s", got)
	}
}

func TestCrashThenResume(t *testing.T) {
	h := newHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "go"})
	p := h.proc(0)
	p.emit(`{"type":"system","subtype":"init","session_id":"sess-1"}`)
	p.exit(errors.New("claude: exit status 1: boom"))
	h.waitStatus(c, "error")
	if s := c.state(); !strings.Contains(s.Error, "boom") {
		t.Fatalf("error = %q", s.Error)
	}
	if got := eventTypes(c.events()); got != "turn:started user turn:error" {
		t.Fatalf("events = %s", got)
	}

	// The next prompt starts a new process resuming the conversation.
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "again"})
	if p2 := h.proc(1); p2.opts.Resume != "sess-1" {
		t.Fatalf("restarted with %+v", p2.opts)
	}
	h.waitStatus(c, "working")
}

func TestIdleProcessIsStopped(t *testing.T) {
	h := newHarness(t)
	h.m.IdleTimeout = 50 * time.Millisecond
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "hi"})
	p := h.proc(0)
	p.emit(`{"type":"result","subtype":"success"}`)
	h.waitStatus(c, "stopped")
	if s := c.state(); s.Error != "" {
		t.Fatalf("idle stop reported an error: %q", s.Error)
	}
	if running, _ := h.m.Status(h.thread); running {
		t.Fatal("still running")
	}
}

func TestSetModeWhileStopped(t *testing.T) {
	h := newHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "setMode", Mode: "plan"})
	eventually(t, "mode", func() bool { return c.state().PermissionMode == "plan" })
	h.do(c, protocol.AgentClientMsg{T: "setMode", Mode: "yolo"})
	eventually(t, "error", func() bool { return len(c.errors()) == 1 })

	h.do(c, protocol.AgentClientMsg{T: "send", Text: "plan it"})
	if p := h.proc(0); p.opts.PermissionMode != "plan" {
		t.Fatalf("started with mode %q", p.opts.PermissionMode)
	}
}

func TestClipJSON(t *testing.T) {
	big := strings.Repeat("x", 100<<10)
	raw, _ := json.Marshal(map[string]string{"file_path": "a.go", "content": big})
	out := clipJSON(raw)
	var v map[string]string
	if err := json.Unmarshal(out, &v); err != nil || v["file_path"] != "a.go" || len(v["content"]) > maxInputString+64 {
		t.Fatalf("clipped to %d bytes: %v", len(out), err)
	}
}
