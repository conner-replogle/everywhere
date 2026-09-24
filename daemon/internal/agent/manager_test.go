package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
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
	flags      []map[string]any
	closed     bool
	exitErr    error
}

func (p *fakeProc) Messages() <-chan claude.Message { return p.msgs }
func (p *fakeProc) Init() claude.InitResponse {
	return claude.InitResponse{
		Account: claude.Account{Email: "me@example.com"},
		Models: []claude.Model{{
			Value: "default", DisplayName: "Default",
			SupportsEffort: true, SupportedEffortLevels: []string{"low", "high", "max"}, SupportsAdaptiveThinking: true,
		}},
		Commands: []claude.SlashCommand{
			{Name: "review", Description: "Review a PR", ArgumentHint: "<pr>"},
			{Name: "compact", Description: "Compact the conversation"},
			{Name: "exit", Description: "Exit the REPL"},
		},
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
func (p *fakeProc) ApplyFlagSettings(_ context.Context, settings map[string]any) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.flags = append(p.flags, settings)
	return nil
}
func (p *fakeProc) Usage(context.Context) (claude.Usage, error) {
	used, resets := 42.0, "2026-09-24T03:00:00Z"
	return claude.Usage{RateLimitsAvailable: true, RateLimits: map[string]*claude.UsageRateLimit{
		"five_hour": {Utilization: &used, ResetsAt: &resets},
	}}, nil
}
func (p *fakeProc) ContextUsage(context.Context) (claude.ContextUsage, error) {
	return claude.ContextUsage{TotalTokens: 30_000, MaxTokens: 200_000}, nil
}
func (p *fakeProc) Close() { p.exit(nil) }

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
	h.m = NewManager(st, t.TempDir(), func() {})
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

func TestInfoProbesOnceThenCaches(t *testing.T) {
	h := newHarness(t)
	info := h.m.Info(context.Background())
	if !info.Available || len(info.Models) != 1 || info.Account == nil || info.Account.Email != "me@example.com" {
		t.Fatalf("Info = %+v", info)
	}
	p := h.proc(0)
	eventually(t, "probe to close", func() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.closed })
	h.m.Info(context.Background())
	h.mu.Lock()
	n := len(h.procs)
	h.mu.Unlock()
	if n != 1 {
		t.Fatalf("second Info started claude again (%d starts)", n)
	}
}

func TestInfoReportsMissingClaude(t *testing.T) {
	h := newHarness(t)
	h.m.start = func(context.Context, claude.Options) (process, error) { return nil, claude.ErrNotInstalled }
	if info := h.m.Info(context.Background()); info.Available || !strings.Contains(info.Error, "not installed") {
		t.Fatalf("Info = %+v", info)
	}
}

// gitRepo makes a one-commit repository on branch main.
func gitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"},
	} {
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	return dir
}

// claudeThreadIn adds a project for dir and a claude thread in it.
func (h *harness) claudeThreadIn(dir string) string {
	h.t.Helper()
	p, err := h.st.CreateProject(dir, "")
	if err != nil {
		h.t.Fatal(err)
	}
	th, err := h.st.CreateThread(p.ID, "", protocol.ThreadClaude)
	if err != nil {
		h.t.Fatal(err)
	}
	return th.ID
}

func TestWorktreeWorkspace(t *testing.T) {
	h := newHarness(t)
	repo := gitRepo(t)
	h.thread = h.claudeThreadIn(repo)
	c := h.attach(0)

	h.do(c, protocol.AgentClientMsg{T: "setWorkspace", Workspace: "worktree", BaseBranch: "main"})
	eventually(t, "worktree mode", func() bool { return c.state().Workspace.Mode == "worktree" })
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "hi"})
	p := h.proc(0)
	h.waitStatus(c, "working")

	ws := c.state().Workspace
	if !ws.Locked || ws.Branch != "everywhere/"+h.thread || !strings.HasPrefix(p.opts.Dir, h.m.WorktreeDir) || p.opts.Dir != ws.Path {
		t.Fatalf("workspace %+v, claude ran in %q", ws, p.opts.Dir)
	}
	if _, err := os.Stat(filepath.Join(ws.Path, ".git")); err != nil {
		t.Fatalf("no worktree at %s: %v", ws.Path, err)
	}
	if got := eventTypes(c.events()); !strings.Contains(got, "notice") {
		t.Fatalf("no worktree notice in %s", got)
	}

	// Locked once started.
	h.do(c, protocol.AgentClientMsg{T: "setWorkspace", Workspace: "local"})
	eventually(t, "lock error", func() bool { return len(c.errors()) == 1 })

	// Deleting the thread removes the worktree but keeps the branch.
	a, _ := h.st.AgentThread(h.thread)
	h.m.Remove(h.thread, a, false)
	if _, err := os.Stat(ws.Path); !os.IsNotExist(err) {
		t.Fatalf("worktree survived: %v", err)
	}
	out, _ := exec.Command("git", "-C", repo, "branch", "--list", ws.Branch).Output()
	if !strings.Contains(string(out), ws.Branch) {
		t.Fatal("branch was deleted with the worktree")
	}
}

func TestWorktreeNeedsGit(t *testing.T) {
	h := newHarness(t)
	h.thread = h.claudeThreadIn(t.TempDir())
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "setWorkspace", Workspace: "worktree"})
	eventually(t, "error", func() bool { return len(c.errors()) == 1 })
	if !strings.Contains(c.errors()[0], "git repository") || c.state().Workspace.Mode != "local" {
		t.Fatalf("errors %v, workspace %+v", c.errors(), c.state().Workspace)
	}
}

func TestAttachments(t *testing.T) {
	h := newHarness(t)
	img, err := h.m.SaveUpload(h.thread, "img00001", "shot.png", "image/png", 4, strings.NewReader("\x89PNG"))
	if err != nil || img.Kind != "image" {
		t.Fatalf("image upload: %+v, %v", img, err)
	}
	doc, err := h.m.SaveUpload(h.thread, "doc00001", "../../notes.txt", "text/plain", 5, strings.NewReader("hello"))
	if err != nil || doc.Kind != "file" || doc.Name != "notes.txt" {
		t.Fatalf("file upload: %+v, %v", doc, err)
	}
	if _, err := h.m.SaveUpload(h.thread, "short001", "a.txt", "text/plain", 10, strings.NewReader("abc")); err == nil {
		t.Fatal("accepted an upload shorter than its declared size")
	}
	if _, err := h.m.SaveUpload(h.thread, "big00001", "a.png", "image/png", MaxImageBytes+1, strings.NewReader("")); err == nil {
		t.Fatal("accepted an oversized image")
	}

	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "look", Attachments: []string{img.ID, doc.ID}})
	p := h.proc(0)
	h.waitStatus(c, "working")
	p.mu.Lock()
	content := p.sent[0].Content
	p.mu.Unlock()
	if len(content) != 2 || content[0].Type != "image" || content[0].Source.MediaType != "image/png" {
		t.Fatalf("content = %+v", content)
	}
	text := content[1].Text
	if !strings.HasPrefix(text, "look\n\n") || !strings.Contains(text, `[Attached file "notes.txt" is saved at: `) {
		t.Fatalf("prompt text = %q", text)
	}
	if len(p.opts.AddDirs) != 1 || !strings.Contains(text, p.opts.AddDirs[0]) {
		t.Fatalf("claude can't reach the attachments: add dirs %v", p.opts.AddDirs)
	}
	var user protocol.AgentEvent
	for _, e := range c.events() {
		if e.Type == "user" {
			user = e
		}
	}
	if len(user.Attachments) != 2 || user.Attachments[1].Name != "notes.txt" {
		t.Fatalf("user event attachments = %+v", user.Attachments)
	}

	h.do(c, protocol.AgentClientMsg{T: "send", Attachments: []string{"missing01"}})
	eventually(t, "missing attachment error", func() bool { return len(c.errors()) == 1 })
}

func TestContextUsage(t *testing.T) {
	h := newHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "hi"})
	p := h.proc(0)
	eventually(t, "context", func() bool { return c.state().Context != nil })
	if u := c.state().Context; u.Used != 30_000 || u.Max != 200_000 || u.Percentage != 15 {
		t.Fatalf("context = %+v", u)
	}
	// Live estimate from the next API call's usage.
	p.emit(`{"type":"stream_event","event":{"type":"message_start","message":{"id":"m","usage":{"input_tokens":10,"cache_read_input_tokens":40000,"cache_creation_input_tokens":0}}}}`)
	eventually(t, "live context", func() bool { return c.state().Context.Used == 40_010 })
	// Stopped threads still show the last known usage.
	if a, _ := h.st.AgentThread(h.thread); !strings.Contains(string(a.Context), `"used":30000`) {
		t.Fatalf("stored context = %s", a.Context)
	}
}

func TestContinueAfterUpdate(t *testing.T) {
	h := newHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "long task"})
	p := h.proc(0)
	p.emit(`{"type":"system","subtype":"init","session_id":"sess-1"}`)
	h.waitStatus(c, "working")
	eventually(t, "session id", func() bool { return c.state().SessionID == "sess-1" })

	h.m.MarkForContinuation()
	h.m.Shutdown()
	if a, _ := h.st.AgentThread(h.thread); !a.Continue {
		t.Fatal("thread wasn't marked to continue")
	}

	// The restarted daemon picks the turn back up, once.
	h.m = NewManager(h.st, t.TempDir(), func() {})
	h.m.start = func(_ context.Context, o claude.Options) (process, error) {
		np := &fakeProc{opts: o, msgs: make(chan claude.Message, 100)}
		h.mu.Lock()
		h.procs = append(h.procs, np)
		h.mu.Unlock()
		return np, nil
	}
	t.Cleanup(h.m.Shutdown)
	h.m.ContinueMarked()
	p2 := h.proc(1)
	eventually(t, "continuation prompt", func() bool {
		p2.mu.Lock()
		defer p2.mu.Unlock()
		return len(p2.sent) == 1 && p2.sent[0].Content[0].Text == continuePrompt
	})
	if p2.opts.Resume != "sess-1" {
		t.Fatalf("continued without resuming: %+v", p2.opts)
	}
	if a, _ := h.st.AgentThread(h.thread); a.Continue {
		t.Fatal("continue mark wasn't cleared")
	}
}

func TestCommandsSuggestionsAndLimits(t *testing.T) {
	h := newHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "hi"})
	p := h.proc(0)
	if !p.opts.PromptSuggestions {
		t.Fatal("claude started without prompt suggestions")
	}
	eventually(t, "limits from get_usage", func() bool {
		l := c.state().Limits
		return len(l) == 1 && l[0].Window == "five_hour" && l[0].Used == 0.42 && l[0].ResetsAt > 0
	})
	if m := c.state().Models[0]; len(m.EffortLevels) != 3 || !m.Thinking {
		t.Fatalf("model = %+v", m)
	}

	// Terminal-only commands are hidden once claude names them.
	p.emit(`{"type":"system","subtype":"init","session_id":"s","terminal_slash_commands":["exit"]}`)
	p.emit(`{"type":"result","subtype":"success"}`)
	h.waitStatus(c, "idle")
	var names []string
	for _, cmd := range c.state().Commands {
		names = append(names, cmd.Name)
	}
	if strings.Join(names, ",") != "compact,review" {
		t.Fatalf("commands = %v", names)
	}

	// A suggestion arrives after the turn and goes away when the next starts.
	p.emit(`{"type":"prompt_suggestion","suggestion":"run the tests","uuid":"u","session_id":"s"}`)
	eventually(t, "suggestion", func() bool { return c.state().Suggestion == "run the tests" })
	p.emit(`{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":0.5,"resetsAt":1790215800},"seven_day":{"utilization":0.1,"resetsAt":1790236800}}}}`)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "run the tests"})
	eventually(t, "suggestion cleared", func() bool { return c.state().Suggestion == "" })
	eventually(t, "limits from rate_limit_event", func() bool {
		l := c.state().Limits
		return len(l) == 2 && l[0].Window == "five_hour" && l[0].Used == 0.5 && l[1].ResetsAt == 1790236800000
	})

	// Local command output lands in the log.
	p.emit(`{"type":"system","subtype":"local_command_output","content":"Total cost: $0.01"}`)
	eventually(t, "command output", func() bool {
		evs := c.events()
		return len(evs) > 0 && evs[len(evs)-1].Type == "commandOutput" && evs[len(evs)-1].Text == "Total cost: $0.01"
	})
}

func TestEffortAndThinking(t *testing.T) {
	h := newHarness(t)
	c := h.attach(0)
	h.waitStatus(c, "stopped")
	if s := c.state(); !s.Thinking || s.Effort != "" {
		t.Fatalf("defaults: effort %q thinking %v", s.Effort, s.Thinking)
	}
	off := false
	h.do(c, protocol.AgentClientMsg{T: "setEffort", Effort: "max"})
	h.do(c, protocol.AgentClientMsg{T: "setThinking", Thinking: &off})
	h.do(c, protocol.AgentClientMsg{T: "setEffort", Effort: "ludicrous"})
	eventually(t, "bad effort refused", func() bool { return len(c.errors()) == 1 })

	// Stored settings apply when claude starts.
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "hi"})
	p := h.proc(0)
	if p.opts.Settings["effortLevel"] != "max" || p.opts.Settings["alwaysThinkingEnabled"] != false {
		t.Fatalf("started with settings %v", p.opts.Settings)
	}

	// While running, changes go through apply_flag_settings.
	on := true
	h.do(c, protocol.AgentClientMsg{T: "setEffort", Effort: ""})
	h.do(c, protocol.AgentClientMsg{T: "setThinking", Thinking: &on})
	eventually(t, "flag settings", func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		return len(p.flags) == 2
	})
	p.mu.Lock()
	flags := p.flags
	p.mu.Unlock()
	if v, ok := flags[0]["effortLevel"]; !ok || v != nil {
		t.Fatalf("clearing effort sent %v", flags[0])
	}
	if flags[1]["alwaysThinkingEnabled"] != true {
		t.Fatalf("thinking on sent %v", flags[1])
	}
	if a, _ := h.st.AgentThread(h.thread); a.Effort != "" || !a.Thinking {
		t.Fatalf("stored effort %q thinking %v", a.Effort, a.Thinking)
	}
}
