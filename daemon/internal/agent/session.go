package agent

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/claude"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

const (
	statusStopped  = "stopped"
	statusStarting = "starting"
	statusIdle     = "idle"
	statusWorking  = "working"
	statusWaiting  = "waiting"
	statusError    = "error"

	replayLimit    = 5000
	startTimeout   = time.Minute
	controlTimeout = 5 * time.Second
	maxOutputBytes = 32 << 10 // per tool result
	maxInputBytes  = 64 << 10 // per tool input
	maxInputString = 16 << 10 // per string inside an oversized tool input
	maxTitleRunes  = 60
)

var (
	permissionModes = []string{"default", "acceptEdits", "plan", "auto", "bypassPermissions"}
	// defaultThreadName matches names the store generates, which a first
	// prompt replaces.
	defaultThreadName = regexp.MustCompile(`^claude \d+$`)
)

type published struct {
	running bool
	status  string
}

// session is one claude thread. Everything below the channels is owned by
// the run goroutine; other goroutines reach it through do.
type session struct {
	m        *Manager
	threadID string
	cmds     chan func()
	quit     chan struct{}
	exited   chan struct{}
	pub      atomic.Pointer[published]

	proc        process
	procMsgs    <-chan claude.Message
	clients     map[Client]bool
	state       protocol.AgentState
	pending     map[string]*claude.PermissionRequest
	turnActive  bool
	interrupted bool // the user stopped the current turn
	stopping    bool // we're closing the process on purpose
	msgID       string
	idle        *time.Timer
	titled      bool
}

func newSession(m *Manager, threadID string, a store.AgentThread) *session {
	s := &session{
		m:        m,
		threadID: threadID,
		cmds:     make(chan func(), 64),
		quit:     make(chan struct{}),
		exited:   make(chan struct{}),
		clients:  map[Client]bool{},
		pending:  map[string]*claude.PermissionRequest{},
		state: protocol.AgentState{
			Status:         statusStopped,
			SessionID:      a.SessionID,
			Model:          a.Model,
			PermissionMode: a.PermissionMode,
			Pending:        []protocol.AgentRequest{},
			Streaming:      []protocol.AgentStreaming{},
		},
	}
	s.pub.Store(&published{status: statusStopped})
	return s
}

// do runs f on the session goroutine. It's dropped if the session has
// stopped.
func (s *session) do(f func()) {
	select {
	case s.cmds <- f:
	case <-s.exited:
	}
}

func (s *session) stop() {
	close(s.quit)
	<-s.exited
}

func (s *session) run() {
	defer close(s.exited)
	for {
		var idle <-chan time.Time
		if s.idle != nil {
			idle = s.idle.C
		}
		select {
		case f := <-s.cmds:
			f()
		case msg, ok := <-s.procMsgs:
			if ok {
				s.handleMessage(msg)
			} else {
				s.onExit()
			}
		case <-idle:
			s.idle = nil
			if s.proc != nil && s.state.Status == statusIdle {
				slog.Info("stopping idle claude", "thread", s.threadID)
				s.closeProc()
			}
		case <-s.quit:
			if s.proc != nil {
				s.closeProc()
				for range s.procMsgs {
				}
			}
			for c := range s.clients {
				c.Send(errorMsg("this thread was closed"))
			}
			return
		}
	}
}

// --- client requests --------------------------------------------------------

func (s *session) attach(c Client, afterSeq int64) {
	events, truncated, err := s.m.store.AgentEvents(s.threadID, afterSeq, replayLimit)
	if err != nil {
		c.Send(errorMsg(err.Error()))
		return
	}
	for _, e := range events {
		c.Send(protocol.AgentEventMsg{T: "event", Seq: e.Seq, At: e.At, Event: e.Event})
	}
	c.Send(protocol.AgentSyncedMsg{T: "synced", Truncated: truncated})
	c.Send(s.stateMsg())
	s.clients[c] = true
}

func (s *session) handle(c Client, msg protocol.AgentClientMsg) {
	var err error
	switch msg.T {
	case "send":
		err = s.send(msg.Text)
	case "interrupt":
		s.interrupt()
	case "respond":
		err = s.respond(msg)
	case "setMode":
		err = s.setMode(msg.Mode)
	case "setModel":
		err = s.setModel(msg.Model)
	default:
		err = fmt.Errorf("unknown request %q", msg.T)
	}
	if err != nil {
		c.Send(errorMsg(err.Error()))
	}
	s.changed()
}

func (s *session) send(text string) error {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	if err := s.ensureProc(); err != nil {
		return err
	}
	id := newUUID()
	if !s.turnActive {
		s.beginTurn()
	}
	s.emit(protocol.AgentEvent{Type: "user", ID: id, Text: text})
	s.maybeTitle(text)
	return s.proc.Send(claude.UserMessage{UUID: id, Content: []claude.ContentBlock{claude.Text(text)}})
}

func (s *session) ensureProc() error {
	if s.proc != nil {
		return nil
	}
	a, err := s.m.store.AgentThread(s.threadID)
	if err != nil {
		return err
	}
	s.state.Status, s.state.Error = statusStarting, ""
	s.changed()

	ctx, cancel := context.WithTimeout(context.Background(), startTimeout)
	defer cancel()
	p, err := s.m.start(ctx, claude.Options{
		Dir:            a.Dir,
		Model:          a.Model,
		PermissionMode: a.PermissionMode,
		Resume:         a.SessionID,
	})
	if err != nil {
		s.state.Status, s.state.Error = statusError, err.Error()
		return err
	}
	s.proc, s.procMsgs = p, p.Messages()
	s.m.noteInit(p.Init())
	s.state.Status = statusIdle
	return nil
}

func (s *session) interrupt() {
	if s.proc == nil || !s.turnActive {
		return
	}
	s.interrupted = true
	ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
	defer cancel()
	if err := s.proc.Interrupt(ctx); err != nil {
		// A stuck CLI; the next prompt resumes the conversation.
		slog.Warn("claude interrupt failed, stopping it", "thread", s.threadID, "err", err)
		s.closeProc()
	}
}

func (s *session) respond(msg protocol.AgentClientMsg) error {
	req := s.pending[msg.RequestID]
	if req == nil {
		return fmt.Errorf("that request is no longer waiting for an answer")
	}
	kind := requestKind(req.ToolName)
	var res claude.PermissionResult
	switch msg.Decision {
	case "allow", "allowSession":
		res = claude.Allow()
		if kind == "question" {
			res.UpdatedInput = withAnswers(req.Input, msg.Answers)
		}
		if msg.Decision == "allowSession" {
			res.UpdatedPermissions = req.Suggestions
		}
	case "deny":
		res = claude.Deny(msg.Message)
	default:
		return fmt.Errorf("unknown decision %q", msg.Decision)
	}
	if err := s.proc.Respond(req, res); err != nil {
		return err
	}
	s.resolve(req.ID, protocol.AgentEvent{Decision: msg.Decision, Answers: msg.Answers, Text: msg.Message})

	// Approving a plan leaves plan mode, into whatever mode the approval
	// picked.
	if res.Behavior == "allow" {
		if mode := setModeIn(res.UpdatedPermissions); mode != "" {
			s.notePermissionMode(mode)
		} else if kind == "plan" && s.state.PermissionMode == "plan" {
			s.notePermissionMode("default")
		}
	}
	return nil
}

func (s *session) setMode(mode string) error {
	if !slices.Contains(permissionModes, mode) {
		return fmt.Errorf("unknown permission mode %q", mode)
	}
	if s.proc != nil {
		ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
		defer cancel()
		if err := s.proc.SetPermissionMode(ctx, mode); err != nil {
			return err
		}
	}
	s.notePermissionMode(mode)
	return nil
}

func (s *session) setModel(model string) error {
	if s.proc != nil {
		ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
		defer cancel()
		m := model
		if m == "" {
			m = "default"
		}
		if err := s.proc.SetModel(ctx, m); err != nil {
			return err
		}
	}
	if err := s.m.store.SetAgentModel(s.threadID, model); err != nil {
		return err
	}
	s.state.Model = model
	return nil
}

func (s *session) notePermissionMode(mode string) {
	s.state.PermissionMode = mode
	if err := s.m.store.SetAgentPermissionMode(s.threadID, mode); err != nil {
		slog.Warn("saving permission mode", "thread", s.threadID, "err", err)
	}
}

// maybeTitle names a thread after its first prompt, unless the user already
// renamed it.
func (s *session) maybeTitle(text string) {
	if s.titled {
		return
	}
	s.titled = true
	t, err := s.m.store.GetThread(s.threadID)
	if err != nil || !defaultThreadName.MatchString(t.Name) {
		return
	}
	title, _, _ := strings.Cut(text, "\n")
	if r := []rune(title); len(r) > maxTitleRunes {
		title = strings.TrimSpace(string(r[:maxTitleRunes-1])) + "…"
	}
	if _, err := s.m.store.RenameThread(s.threadID, title); err == nil {
		s.m.onChange()
	}
}

// --- claude output ------------------------------------------------------------

func (s *session) handleMessage(msg claude.Message) {
	switch msg.Type {
	case "system":
		s.onSystem(msg)
	case "stream_event":
		// Streamed text goes out as deltas, not state pushes.
		if msg.ParentToolUseID == "" {
			s.onStreamEvent(msg)
		}
		return
	case "assistant":
		s.onAssistant(msg)
	case "user":
		s.onUser(msg)
	case "result":
		s.onResult(msg)
	case "control_request":
		s.onPermission(msg.Permission)
	case "control_cancel_request":
		s.resolve(msg.CanceledRequestID, protocol.AgentEvent{Decision: "canceled"})
	case "rate_limit_event":
		var f struct {
			Info json.RawMessage `json:"rate_limit_info"`
		}
		if msg.Decode(&f) == nil {
			s.state.RateLimit = f.Info
		}
	default:
		return
	}
	s.changed()
}

func (s *session) onSystem(msg claude.Message) {
	switch msg.Subtype {
	case "init":
		var f struct {
			Model          string `json:"model"`
			PermissionMode string `json:"permissionMode"`
		}
		_ = msg.Decode(&f)
		s.state.ActiveModel = f.Model
		if f.PermissionMode != "" {
			s.state.PermissionMode = f.PermissionMode
		}
		if msg.SessionID != "" && msg.SessionID != s.state.SessionID {
			if err := s.m.store.SetAgentSessionID(s.threadID, msg.SessionID); err != nil {
				slog.Warn("saving claude session id", "thread", s.threadID, "err", err)
			}
			s.state.SessionID = msg.SessionID
		}
	case "compact_boundary":
		s.emit(protocol.AgentEvent{Type: "notice", Text: "Conversation compacted"})
	}
}

func (s *session) onStreamEvent(msg claude.Message) {
	var f struct {
		Event struct {
			Type    string `json:"type"`
			Index   int    `json:"index"`
			Message struct {
				ID string `json:"id"`
			} `json:"message"`
			ContentBlock struct {
				Type string `json:"type"`
			} `json:"content_block"`
			Delta struct {
				Type     string `json:"type"`
				Text     string `json:"text"`
				Thinking string `json:"thinking"`
			} `json:"delta"`
		} `json:"event"`
	}
	if msg.Decode(&f) != nil {
		return
	}
	if !s.turnActive {
		s.beginTurn()
		s.changed()
	}
	ev := f.Event
	key := fmt.Sprintf("%s:%d", s.msgID, ev.Index)
	switch ev.Type {
	case "message_start":
		s.msgID = ev.Message.ID
	case "content_block_start":
		if kind := streamKind(ev.ContentBlock.Type); kind != "" {
			s.state.Streaming = append(s.state.Streaming, protocol.AgentStreaming{Key: key, Kind: kind})
		}
	case "content_block_delta":
		text := ev.Delta.Text
		if ev.Delta.Type == "thinking_delta" {
			text = ev.Delta.Thinking
		}
		if text == "" {
			return
		}
		for i := range s.state.Streaming {
			if st := &s.state.Streaming[i]; st.Key == key {
				st.Text += text
				s.broadcast(protocol.AgentDeltaMsg{T: "delta", Key: key, Kind: st.Kind, Text: text})
			}
		}
	}
}

func (s *session) onAssistant(msg claude.Message) {
	var f struct {
		Message struct {
			ID      string `json:"id"`
			Content []struct {
				Type     string          `json:"type"`
				Text     string          `json:"text"`
				Thinking string          `json:"thinking"`
				ID       string          `json:"id"`
				Name     string          `json:"name"`
				Input    json.RawMessage `json:"input"`
			} `json:"content"`
		} `json:"message"`
		Error string `json:"error"`
	}
	if msg.Decode(&f) != nil {
		return
	}
	if !s.turnActive {
		s.beginTurn()
	}
	for i, b := range f.Message.Content {
		id := msg.UUID
		if i > 0 {
			id = fmt.Sprintf("%s:%d", msg.UUID, i)
		}
		ev := protocol.AgentEvent{ID: id, ParentID: msg.ParentToolUseID}
		switch b.Type {
		case "text":
			ev.Type, ev.Text = "assistant", b.Text
			ev.StreamKey = s.takeStream(f.Message.ID, "text")
		case "thinking":
			ev.Type, ev.Text = "thinking", b.Thinking
			ev.StreamKey = s.takeStream(f.Message.ID, "thinking")
			if b.Thinking == "" {
				continue // redacted or not summarized
			}
		case "tool_use", "server_tool_use", "mcp_tool_use":
			ev.Type, ev.ID, ev.Name, ev.Input = "tool", b.ID, b.Name, clipJSON(b.Input)
		default:
			continue
		}
		s.emit(ev)
	}
	if f.Error != "" {
		s.emit(protocol.AgentEvent{Type: "notice", Text: "Claude reported an error: " + f.Error})
	}
}

func (s *session) onUser(msg claude.Message) {
	var f struct {
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if msg.Decode(&f) != nil {
		return
	}
	var blocks []struct {
		Type      string          `json:"type"`
		ToolUseID string          `json:"tool_use_id"`
		Content   json.RawMessage `json:"content"`
		IsError   bool            `json:"is_error"`
	}
	if json.Unmarshal(f.Message.Content, &blocks) != nil {
		return // plain text: an echo of a prompt, already logged
	}
	for _, b := range blocks {
		if b.Type != "tool_result" {
			continue
		}
		s.emit(protocol.AgentEvent{
			Type:     "toolResult",
			ID:       b.ToolUseID,
			ParentID: msg.ParentToolUseID,
			Output:   clipText(contentText(b.Content), maxOutputBytes),
			IsError:  b.IsError,
		})
	}
}

func (s *session) onResult(msg claude.Message) {
	var r claude.Result
	var e struct {
		Errors []string `json:"errors"`
	}
	if msg.Decode(&r) != nil || msg.Decode(&e) != nil {
		return
	}
	ev := protocol.AgentEvent{Type: "turn", Status: "completed", CostUSD: r.TotalCostUSD, DurationMS: r.DurationMS}
	switch {
	case s.interrupted:
		ev.Status = "interrupted"
	case r.IsError || r.Subtype != "success":
		ev.Status = "error"
		ev.Text = r.Result
		if len(e.Errors) > 0 {
			ev.Text = strings.Join(e.Errors, "\n")
		}
	}
	s.endTurn(ev)
}

func (s *session) onPermission(req *claude.PermissionRequest) {
	if req == nil {
		return
	}
	if !s.turnActive {
		s.beginTurn()
	}
	s.pending[req.ID] = req
	s.state.Pending = append(s.state.Pending, protocol.AgentRequest{
		ID:              req.ID,
		Kind:            requestKind(req.ToolName),
		ToolName:        req.ToolName,
		ToolUseID:       req.ToolUseID,
		Input:           clipJSON(req.Input),
		Title:           req.Title,
		Description:     req.Description,
		DecisionReason:  req.DecisionReason,
		CanAllowSession: len(req.Suggestions) > 0,
	})
}

// onExit handles the claude process ending, on purpose or not.
func (s *session) onExit() {
	err := s.proc.Err()
	s.proc, s.procMsgs = nil, nil
	expected := s.stopping || s.interrupted
	if s.turnActive {
		ev := protocol.AgentEvent{Type: "turn", Status: "interrupted"}
		if !expected {
			ev.Status, ev.Text = "error", "claude exited unexpectedly"
		}
		s.endTurn(ev)
	}
	s.state.ActiveModel = ""
	s.state.Status, s.state.Error = statusStopped, ""
	if err != nil && !expected {
		slog.Warn("claude exited", "thread", s.threadID, "err", err)
		s.state.Status, s.state.Error = statusError, err.Error()
	}
	s.stopping, s.interrupted = false, false
	s.changed()
}

// --- helpers --------------------------------------------------------------------

func (s *session) beginTurn() {
	s.turnActive, s.interrupted = true, false
	s.emit(protocol.AgentEvent{Type: "turn", Status: "started"})
}

func (s *session) endTurn(ev protocol.AgentEvent) {
	for id := range s.pending {
		s.resolve(id, protocol.AgentEvent{Decision: "canceled"})
	}
	s.turnActive, s.interrupted = false, false
	s.state.Streaming = []protocol.AgentStreaming{}
	s.emit(ev)
}

// resolve records the outcome of a pending request and forgets it. ev
// carries the decision details.
func (s *session) resolve(id string, ev protocol.AgentEvent) {
	req := s.pending[id]
	if req == nil {
		return
	}
	delete(s.pending, id)
	for i, p := range s.state.Pending {
		if p.ID == id {
			s.state.Pending = append(s.state.Pending[:i:i], s.state.Pending[i+1:]...)
			break
		}
	}
	ev.Type, ev.ID, ev.Kind, ev.ToolName = "request", id, requestKind(req.ToolName), req.ToolName
	s.emit(ev)
}

// takeStream removes and returns the key of the oldest streaming block of
// the given kind in API message msgID.
func (s *session) takeStream(msgID, kind string) string {
	for i, st := range s.state.Streaming {
		if st.Kind == kind && strings.HasPrefix(st.Key, msgID+":") {
			s.state.Streaming = append(s.state.Streaming[:i:i], s.state.Streaming[i+1:]...)
			return st.Key
		}
	}
	return ""
}

func (s *session) closeProc() {
	s.stopping = true
	s.proc.Close()
}

func (s *session) emit(ev protocol.AgentEvent) {
	raw, err := json.Marshal(ev)
	if err != nil {
		return
	}
	e, err := s.m.store.AppendAgentEvent(s.threadID, raw)
	if err != nil {
		slog.Warn("saving agent event", "thread", s.threadID, "err", err)
		return
	}
	s.broadcast(protocol.AgentEventMsg{T: "event", Seq: e.Seq, At: e.At, Event: e.Event})
}

func (s *session) broadcast(frame any) {
	for c := range s.clients {
		c.Send(frame)
	}
}

func (s *session) stateMsg() protocol.AgentStateMsg {
	st := s.state
	st.Models, st.Account = s.m.initInfo()
	if st.Models == nil {
		st.Models = []protocol.AgentModel{}
	}
	return protocol.AgentStateMsg{T: "state", State: st}
}

// changed recomputes the status of a running session, pushes the state to
// clients and tells the manager if the thread's summary changed.
func (s *session) changed() {
	if s.proc != nil && s.state.Status != statusStarting {
		switch {
		case len(s.pending) > 0:
			s.state.Status = statusWaiting
		case s.turnActive:
			s.state.Status = statusWorking
		default:
			s.state.Status = statusIdle
		}
	}
	if s.state.Status == statusIdle {
		if s.idle == nil {
			s.idle = time.NewTimer(s.m.IdleTimeout)
		}
	} else if s.idle != nil {
		s.idle.Stop()
		s.idle = nil
	}
	s.broadcast(s.stateMsg())
	next := &published{running: s.proc != nil, status: s.state.Status}
	if prev := s.pub.Swap(next); *prev != *next {
		s.m.onChange()
	}
}

func requestKind(toolName string) string {
	switch toolName {
	case "AskUserQuestion":
		return "question"
	case "ExitPlanMode":
		return "plan"
	}
	return "tool"
}

func streamKind(blockType string) string {
	switch blockType {
	case "text":
		return "text"
	case "thinking":
		return "thinking"
	}
	return ""
}

// withAnswers adds AskUserQuestion answers to its input, which is how the
// tool receives them.
func withAnswers(input json.RawMessage, answers map[string]string) json.RawMessage {
	var m map[string]any
	if json.Unmarshal(input, &m) != nil || m == nil {
		m = map[string]any{}
	}
	m["answers"] = answers
	out, _ := json.Marshal(m)
	return out
}

// setModeIn returns the mode a set of permission updates switches to.
func setModeIn(updates []json.RawMessage) string {
	for _, u := range updates {
		var f struct {
			Type string `json:"type"`
			Mode string `json:"mode"`
		}
		if json.Unmarshal(u, &f) == nil && f.Type == "setMode" {
			return f.Mode
		}
	}
	return ""
}

// contentText flattens tool_result content: a string or text blocks.
func contentText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return string(raw)
	}
	var parts []string
	for _, b := range blocks {
		switch b.Type {
		case "text":
			parts = append(parts, b.Text)
		case "image":
			parts = append(parts, "[image]")
		}
	}
	return strings.Join(parts, "\n")
}

func clipText(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return strings.ToValidUTF8(s[:max], "") + fmt.Sprintf("\n… [%d more bytes]", len(s)-max)
}

// clipJSON bounds a tool input for the log and the wire: long strings (file
// contents, big commands) are cut, and anything still too big becomes a
// preview.
func clipJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) <= maxInputBytes {
		return raw
	}
	var v any
	if json.Unmarshal(raw, &v) == nil {
		if out, err := json.Marshal(clipStrings(v)); err == nil && len(out) <= maxInputBytes {
			return out
		}
	}
	out, _ := json.Marshal(map[string]any{"truncated": true, "preview": clipText(string(raw), maxInputString)})
	return out
}

func clipStrings(v any) any {
	switch t := v.(type) {
	case string:
		return clipText(t, maxInputString)
	case []any:
		for i := range t {
			t[i] = clipStrings(t[i])
		}
	case map[string]any:
		for k := range t {
			t[k] = clipStrings(t[k])
		}
	}
	return v
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
