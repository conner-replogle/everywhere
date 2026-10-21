package harness

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/claude"
	"github.com/conner-replogle/everywhere/daemon/internal/version"
)

// Conn is an ACP agent's session, as package agent drives a claude
// process: the same calls, and the same messages out. Claude Code's stream
// (package claude's Message) is the agent engine's common language, so
// what the agent says is translated into it: streamed text and thinking,
// tool calls named in the common vocabulary, their results, permission
// prompts, and a result when a prompt's turn ends. Settings and usage that
// claude reports otherwise come as system messages of their own
// (harness_config, harness_usage).
type Conn struct {
	agent     Agent
	conn      *acpConn
	sessionID string
	init      acpInitializeResult

	msgs chan claude.Message

	mu sync.Mutex
	// out is what's waiting to go out on msgs, so a message never waits on
	// its reader; ended: no more will come.
	out   []claude.Message
	wake  *sync.Cond
	ended bool
	// loading: session/load is replaying the conversation, which the
	// engine's log already has.
	loading bool
	// prompting: a prompt's turn is running; prompts sent meanwhile wait.
	prompting bool
	queued    [][]acpContentBlock
	tools     map[string]*toolCall
	// The block being streamed, of each kind.
	text, thought stream
	used, size    int
	pending       map[string]*permission
	modelConfig   string
	modeConfig    string
	// options are the values each setting takes.
	options map[string]map[string]bool
	closing bool
}

type stream struct {
	msgID string
	text  strings.Builder
}

type permission struct {
	options map[string]string // allow | allowSession | deny -> optionId
	reply   chan string       // the chosen optionId; "" cancels
}

// StartOptions is how an agent's session starts.
type StartOptions struct {
	Agent Agent
	Dir   string
	// Resume is the session to reload, if the agent can.
	Resume      string
	Model, Mode string
	MCP         []MCPServer
}

// MCPServer is an MCP server (over HTTP) the agent gets.
type MCPServer struct {
	Name    string
	URL     string
	Headers map[string]string
}

// Start runs the agent, initializes it and opens (or reloads) its session.
func Start(ctx context.Context, o StartOptions) (*Conn, error) {
	c := &Conn{
		agent: o.Agent, msgs: make(chan claude.Message, 64),
		tools: map[string]*toolCall{}, pending: map[string]*permission{},
	}
	c.wake = sync.NewCond(&c.mu)
	conn, err := startACP(o.Agent.Command, o.Dir, nil, c.onNotify, c.onRequest)
	if err != nil {
		return nil, err
	}
	c.conn = conn
	go c.pump()
	go func() {
		<-conn.done
		c.mu.Lock()
		c.ended = true
		for _, p := range c.pending {
			close(p.reply)
		}
		c.pending = map[string]*permission{}
		c.wake.Broadcast()
		c.mu.Unlock()
	}()
	fail := func(err error) (*Conn, error) {
		conn.close()
		return nil, err
	}
	if err := conn.call(ctx, "initialize", map[string]any{
		"protocolVersion": acpVersion,
		"clientCapabilities": map[string]any{
			"fs":       map[string]bool{"readTextFile": false, "writeTextFile": false},
			"terminal": false,
		},
		"clientInfo": map[string]string{"name": "everywhere", "title": "everywhere", "version": version.Version},
	}, &c.init); err != nil {
		return fail(err)
	}
	servers := []acpMCPServer{}
	if c.init.AgentCapabilities.MCPCapabilities.HTTP {
		for _, m := range o.MCP {
			srv := acpMCPServer{Type: "http", Name: m.Name, URL: m.URL, Headers: []acpHTTPHeader{}}
			for k, v := range m.Headers {
				srv.Headers = append(srv.Headers, acpHTTPHeader{Name: k, Value: v})
			}
			servers = append(servers, srv)
		}
	}
	var res acpSessionResult
	loaded := false
	if o.Resume != "" && c.init.AgentCapabilities.LoadSession {
		c.setLoading(true)
		err := conn.call(ctx, "session/load", map[string]any{"sessionId": o.Resume, "cwd": o.Dir, "mcpServers": servers}, &res)
		c.setLoading(false)
		if err == nil {
			res.SessionID, loaded = o.Resume, true
		}
	}
	if !loaded {
		if err := conn.call(ctx, "session/new", map[string]any{"cwd": o.Dir, "mcpServers": servers}, &res); err != nil {
			return fail(err)
		}
		if o.Resume != "" {
			c.emitSystem("harness_notice", map[string]any{"text": o.Agent.Title + " couldn't reload the conversation; it goes on in a new session, without the earlier context"})
		}
	}
	c.sessionID = res.SessionID
	c.applyConfig(res.ConfigOptions, res)
	// What was chosen before (or on another device) wins over the agent's defaults.
	if o.Model != "" && c.modelConfig != "" {
		_ = c.setConfig(ctx, c.modelConfig, o.Model)
	}
	if o.Mode != "" && c.modeConfig != "" && c.hasOption(c.modeConfig, o.Mode) {
		_ = c.setConfig(ctx, c.modeConfig, o.Mode)
	}
	c.emit(message("system", "init", map[string]any{"session_id": c.sessionID}))
	return c, nil
}

// Version is the agent's version, as it says.
func (c *Conn) Version() string { return c.init.AgentInfo.Version }

// CanImage: prompts can carry images.
func (c *Conn) CanImage() bool { return c.init.AgentCapabilities.PromptCapabilities.Image }

// --- the process calls ---------------------------------------------------------

func (c *Conn) Messages() <-chan claude.Message { return c.msgs }

// Init is empty: an ACP agent reports its settings with harness_config.
func (c *Conn) Init() claude.InitResponse { return claude.InitResponse{} }

func (c *Conn) Err() error {
	c.mu.Lock()
	closing := c.closing
	c.mu.Unlock()
	if closing {
		return nil
	}
	select {
	case <-c.conn.done:
		return c.conn.exitErr()
	default:
		return nil
	}
}

// Send sends a prompt. One sent during a turn waits for it to end: an ACP
// agent runs one prompt at a time.
func (c *Conn) Send(m claude.UserMessage) error {
	blocks := []acpContentBlock{}
	for _, b := range m.Content {
		switch {
		case b.Type == "text" && b.Text != "":
			blocks = append(blocks, acpContentBlock{Type: "text", Text: b.Text})
		case b.Type == "image" && b.Source != nil && c.CanImage():
			blocks = append(blocks, acpContentBlock{Type: "image", MimeType: b.Source.MediaType, Data: b.Source.Data})
		}
	}
	if len(blocks) == 0 {
		return nil
	}
	c.mu.Lock()
	if c.prompting {
		c.queued = append(c.queued, blocks)
		c.mu.Unlock()
		return nil
	}
	c.prompting = true
	c.mu.Unlock()
	go c.prompt(blocks)
	return nil
}

func (c *Conn) prompt(blocks []acpContentBlock) {
	start := time.Now()
	var res struct {
		StopReason string `json:"stopReason"`
	}
	err := c.conn.call(context.Background(), "session/prompt", map[string]any{"sessionId": c.sessionID, "prompt": blocks}, &res)
	c.mu.Lock()
	c.flushLocked()
	result := map[string]any{"subtype": "success", "duration_ms": time.Since(start).Milliseconds(), "stop_reason": res.StopReason}
	fail := func(text string) {
		result["subtype"], result["is_error"], result["result"] = "error_during_execution", true, text
	}
	switch {
	case err != nil:
		fail(err.Error())
	case res.StopReason == "max_tokens":
		fail("The reply hit the model's output limit.")
	case res.StopReason == "max_turn_requests":
		fail("The turn hit the agent's limit on model requests.")
	case res.StopReason == "refusal":
		fail("The model declined to continue.")
	}
	c.emitLocked(message("result", "", result))
	c.tools = map[string]*toolCall{}
	var next []acpContentBlock
	if len(c.queued) > 0 {
		next, c.queued = c.queued[0], c.queued[1:]
	} else {
		c.prompting = false
	}
	c.mu.Unlock()
	if next != nil {
		c.prompt(next)
	}
}

// Respond answers a permission prompt: allow, allow for the session (when
// the agent offers it, Suggestions say so), or deny.
func (c *Conn) Respond(req *claude.PermissionRequest, res claude.PermissionResult) error {
	c.mu.Lock()
	p := c.pending[req.ID]
	delete(c.pending, req.ID)
	c.mu.Unlock()
	if p == nil {
		return errors.New("that request is no longer waiting for an answer")
	}
	choice := "deny"
	if res.Behavior == "allow" {
		choice = "allow"
		if len(res.UpdatedPermissions) > 0 && p.options["allowSession"] != "" {
			choice = "allowSession"
		}
	}
	p.reply <- p.options[choice]
	return nil
}

// Interrupt cancels the turn; prompts it was waiting on are cancelled too.
func (c *Conn) Interrupt(context.Context) error {
	c.mu.Lock()
	c.queued = nil
	for id, p := range c.pending {
		p.reply <- ""
		delete(c.pending, id)
		c.emitLocked(claude.Message{Type: "control_cancel_request", CanceledRequestID: id})
	}
	c.mu.Unlock()
	c.conn.notify("session/cancel", map[string]string{"sessionId": c.sessionID})
	return nil
}

func (c *Conn) SetPermissionMode(ctx context.Context, mode string) error {
	if c.modeConfig == "" {
		return fmt.Errorf("%s has no modes", c.agent.Title)
	}
	return c.setConfig(ctx, c.modeConfig, mode)
}

func (c *Conn) SetModel(ctx context.Context, model string) error {
	if model == "" || model == "default" || c.modelConfig == "" {
		return nil
	}
	return c.setConfig(ctx, c.modelConfig, model)
}

func (c *Conn) ContextUsage(context.Context) (claude.ContextUsage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.size == 0 {
		return claude.ContextUsage{}, errUnsupported
	}
	return claude.ContextUsage{TotalTokens: c.used, MaxTokens: c.size}, nil
}

var errUnsupported = errors.New("the agent doesn't do that")

func (c *Conn) GenerateTitle(context.Context, string, bool) (string, error) {
	return "", errUnsupported
}
func (c *Conn) ApplyFlagSettings(context.Context, map[string]any) error { return errUnsupported }
func (c *Conn) Usage(context.Context) (claude.Usage, error)             { return claude.Usage{}, errUnsupported }
func (c *Conn) RewindFiles(context.Context, string, bool) (claude.RewindFilesResult, error) {
	return claude.RewindFilesResult{}, errUnsupported
}

// Close stops the agent; its messages end.
func (c *Conn) Close() {
	c.mu.Lock()
	c.closing = true
	c.mu.Unlock()
	c.conn.close()
}

// --- settings ------------------------------------------------------------------

func (c *Conn) setConfig(ctx context.Context, id, value string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var res struct {
		ConfigOptions []acpConfigOption `json:"configOptions"`
	}
	err := c.conn.call(ctx, "session/set_config_option", map[string]any{"sessionId": c.sessionID, "configId": id, "value": value}, &res)
	var re *rpcError
	if errors.As(err, &re) && re.Code == -32601 && id == "mode" {
		// Agents from before config options set modes this way.
		err = c.conn.call(ctx, "session/set_mode", map[string]any{"sessionId": c.sessionID, "modeId": value}, nil)
	}
	if err != nil {
		return err
	}
	if len(res.ConfigOptions) > 0 {
		c.applyConfig(res.ConfigOptions, acpSessionResult{})
	}
	return nil
}

func (c *Conn) hasOption(id, value string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.options[id] != nil && c.options[id][value]
}

// applyConfig takes the agent's models and modes and tells the engine.
func (c *Conn) applyConfig(opts []acpConfigOption, res acpSessionResult) {
	cfg := map[string]any{}
	c.mu.Lock()
	if c.options == nil {
		c.options = map[string]map[string]bool{}
	}
	for _, o := range opts {
		values := []map[string]string{}
		known := map[string]bool{}
		for _, v := range o.Options {
			values = append(values, map[string]string{"value": v.Value, "label": v.Name, "description": v.Description})
			known[v.Value] = true
		}
		switch {
		case o.Category == "model" || o.ID == "model":
			c.modelConfig = o.ID
			cfg["models"], cfg["model"] = values, o.CurrentValue
		case o.Category == "mode" || o.ID == "mode":
			c.modeConfig = o.ID
			cfg["modes"], cfg["mode"] = values, o.CurrentValue
		default:
			continue
		}
		c.options[o.ID] = known
	}
	if res.Modes != nil && c.modeConfig == "" {
		c.modeConfig = "mode"
		values := []map[string]string{}
		known := map[string]bool{}
		for _, m := range res.Modes.AvailableModes {
			values = append(values, map[string]string{"value": m.ID, "label": m.Name, "description": m.Description})
			known[m.ID] = true
		}
		c.options["mode"] = known
		cfg["modes"], cfg["mode"] = values, res.Modes.CurrentModeID
	}
	if len(cfg) > 0 {
		c.emitLocked(message("system", "harness_config", cfg))
	}
	c.mu.Unlock()
}

// --- what the agent says --------------------------------------------------------

func (c *Conn) setLoading(on bool) {
	c.mu.Lock()
	c.loading = on
	c.mu.Unlock()
}

func (c *Conn) onNotify(method string, params json.RawMessage) {
	if method != "session/update" {
		return
	}
	var n struct {
		Update acpUpdate `json:"update"`
	}
	if json.Unmarshal(params, &n) != nil {
		return
	}
	u := n.Update
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.loading {
		switch u.SessionUpdate {
		case "agent_message_chunk", "agent_thought_chunk", "user_message_chunk", "tool_call", "tool_call_update", "plan":
			return
		}
	}
	switch u.SessionUpdate {
	case "agent_message_chunk":
		c.streamLocked(&c.text, "text", contentText(u.Content))
	case "agent_thought_chunk":
		c.streamLocked(&c.thought, "thinking", contentText(u.Content))
	case "tool_call", "tool_call_update":
		c.toolLocked(u)
	case "plan":
		c.planLocked(u)
	case "available_commands_update":
		cmds := []claude.SlashCommand{}
		for _, a := range u.AvailableCommands {
			cmd := claude.SlashCommand{Name: a.Name, Description: clip(a.Description, 200)}
			if a.Input != nil {
				cmd.ArgumentHint = a.Input.Hint
			}
			cmds = append(cmds, cmd)
		}
		c.emitLocked(message("system", "commands_changed", map[string]any{"commands": cmds}))
	case "current_mode_update":
		c.emitLocked(message("system", "harness_config", map[string]any{"mode": u.CurrentModeID}))
	case "config_option_update":
		c.mu.Unlock()
		c.applyConfig(u.ConfigOptions, acpSessionResult{})
		c.mu.Lock()
	case "usage_update":
		if u.Size > 0 {
			c.used, c.size = u.Used, u.Size
			c.emitLocked(message("system", "harness_usage", map[string]any{"used": u.Used, "size": u.Size}))
		}
	}
}

// streamLocked adds text to the block being streamed of its kind (as
// claude's stream events); the block is completed (an assistant message)
// when something else follows it.
func (c *Conn) streamLocked(s *stream, kind, text string) {
	if text == "" {
		return
	}
	if kind == "text" {
		c.flushOneLocked(&c.thought, "thinking")
	} else {
		c.flushOneLocked(&c.text, "text")
	}
	if s.msgID == "" {
		s.msgID = "msg_" + newID()
		c.emitLocked(message("stream_event", "", map[string]any{"event": map[string]any{
			"type": "message_start", "message": map[string]any{"id": s.msgID, "usage": map[string]int{"input_tokens": c.used}},
		}}))
		c.emitLocked(message("stream_event", "", map[string]any{"event": map[string]any{
			"type": "content_block_start", "index": 0, "content_block": map[string]string{"type": kind},
		}}))
	}
	s.text.WriteString(text)
	delta := map[string]string{"type": "text_delta", "text": text}
	if kind == "thinking" {
		delta = map[string]string{"type": "thinking_delta", "thinking": text}
	}
	c.emitLocked(message("stream_event", "", map[string]any{"event": map[string]any{
		"type": "content_block_delta", "index": 0, "delta": delta,
	}}))
}

func (c *Conn) flushOneLocked(s *stream, kind string) {
	if s.msgID == "" {
		return
	}
	block := map[string]string{"type": "text", "text": s.text.String()}
	if kind == "thinking" {
		block = map[string]string{"type": "thinking", "thinking": s.text.String()}
	}
	m := message("assistant", "", map[string]any{"message": map[string]any{"id": s.msgID, "content": []any{block}}})
	m.UUID = newID()
	c.emitLocked(m)
	s.msgID = ""
	s.text.Reset()
}

func (c *Conn) flushLocked() {
	c.flushOneLocked(&c.thought, "thinking")
	c.flushOneLocked(&c.text, "text")
}

func (c *Conn) toolLocked(u acpUpdate) {
	t := c.tools[u.ToolCallID]
	if t == nil {
		t = &toolCall{id: u.ToolCallID}
		c.tools[u.ToolCallID] = t
	}
	t.update(u)
	for _, tc := range toolContents(u) {
		switch tc.Type {
		case "diff":
			tc := tc
			t.diff = &tc
		case "content":
			if text := contentText(tc.Content); text != "" {
				t.output.Reset()
				t.output.WriteString(text)
			}
		}
	}
	if !t.emitted && t.ready(u.Status) {
		c.emitToolLocked(t)
	}
	if t.emitted && (u.Status == "completed" || u.Status == "failed") {
		out := t.output.String()
		if out == "" && len(u.RawOutput) > 0 {
			var ro struct {
				Output string `json:"output"`
				Error  string `json:"error"`
			}
			if json.Unmarshal(u.RawOutput, &ro) == nil {
				out = ro.Output + ro.Error
			}
		}
		c.emitLocked(message("user", "", map[string]any{"message": map[string]any{"content": []any{map[string]any{
			"type": "tool_result", "tool_use_id": t.id, "content": out, "is_error": u.Status == "failed",
		}}}}))
		delete(c.tools, t.id)
	}
}

func (c *Conn) emitToolLocked(t *toolCall) {
	c.flushLocked()
	t.emitted = true
	name, input := t.named()
	m := message("assistant", "", map[string]any{"message": map[string]any{"id": "msg_" + newID(), "content": []any{map[string]any{
		"type": "tool_use", "id": t.id, "name": name, "input": input,
	}}}})
	m.UUID = newID()
	c.emitLocked(m)
}

// planLocked shows the agent's plan as a TodoWrite, which the timeline
// draws as a checklist.
func (c *Conn) planLocked(u acpUpdate) {
	todos := make([]map[string]string, 0, len(u.Entries))
	for _, e := range u.Entries {
		todos = append(todos, map[string]string{"content": e.Content, "status": e.Status, "activeForm": e.Content})
	}
	t := &toolCall{id: "plan_" + newID(), title: "todowrite", input: map[string]any{"todos": todos}}
	c.emitToolLocked(t)
	c.emitLocked(message("user", "", map[string]any{"message": map[string]any{"content": []any{map[string]any{
		"type": "tool_result", "tool_use_id": t.id, "content": "Plan updated",
	}}}}))
}

// --- permission prompts ----------------------------------------------------------

func (c *Conn) onRequest(method string, params json.RawMessage) (any, error) {
	if method != "session/request_permission" {
		return nil, &rpcError{Code: -32601, Message: "method not found: " + method}
	}
	var r acpPermissionRequest
	if err := json.Unmarshal(params, &r); err != nil {
		return nil, err
	}
	p := &permission{options: map[string]string{}, reply: make(chan string, 1)}
	for _, o := range r.Options {
		switch o.Kind {
		case "allow_once":
			p.options["allow"] = o.OptionID
		case "allow_always":
			p.options["allowSession"] = o.OptionID
		case "reject_once":
			p.options["deny"] = o.OptionID
		case "reject_always":
			if p.options["deny"] == "" {
				p.options["deny"] = o.OptionID
			}
		}
	}
	if p.options["allow"] == "" {
		p.options["allow"] = p.options["allowSession"]
	}
	c.mu.Lock()
	if c.ended {
		c.mu.Unlock()
		return cancelled(), nil
	}
	t := c.tools[r.ToolCall.ToolCallID]
	if t == nil {
		t = &toolCall{id: r.ToolCall.ToolCallID}
		c.tools[t.id] = t
	}
	t.update(r.ToolCall)
	if !t.emitted {
		c.emitToolLocked(t)
	}
	name, input := t.named()
	req := &claude.PermissionRequest{ID: newID(), ToolName: name, ToolUseID: t.id, Input: input, Title: t.title}
	if p.options["allowSession"] != "" {
		// The engine offers "allow for the session" when there are suggestions.
		req.Suggestions = []json.RawMessage{json.RawMessage(`{"type":"allowAlways"}`)}
	}
	c.pending[req.ID] = p
	c.emitLocked(claude.Message{Type: "control_request", Permission: req})
	c.mu.Unlock()
	option, ok := <-p.reply
	if !ok || option == "" {
		return cancelled(), nil
	}
	return map[string]any{"outcome": map[string]string{"outcome": "selected", "optionId": option}}, nil
}

func cancelled() any {
	return map[string]any{"outcome": map[string]string{"outcome": "cancelled"}}
}

// --- the message stream ---------------------------------------------------------

// message builds a claude stream message: its header, and the whole frame in Raw.
func message(typ, subtype string, fields map[string]any) claude.Message {
	frame := map[string]any{"type": typ}
	if subtype != "" {
		frame["subtype"] = subtype
	}
	for k, v := range fields {
		frame[k] = v
	}
	raw, _ := json.Marshal(frame)
	m := claude.Message{Type: typ, Subtype: subtype, Raw: raw}
	if sid, ok := fields["session_id"].(string); ok {
		m.SessionID = sid
	}
	return m
}

func (c *Conn) emitSystem(subtype string, fields map[string]any) {
	c.emit(message("system", subtype, fields))
}

func (c *Conn) emit(m claude.Message) {
	c.mu.Lock()
	c.emitLocked(m)
	c.mu.Unlock()
}

func (c *Conn) emitLocked(m claude.Message) {
	if c.ended {
		return
	}
	c.out = append(c.out, m)
	c.wake.Signal()
}

// pump hands messages to the engine in order, and closes the stream once
// the agent has exited and everything it said is out.
func (c *Conn) pump() {
	for {
		c.mu.Lock()
		for len(c.out) == 0 && !c.ended {
			c.wake.Wait()
		}
		if len(c.out) == 0 {
			c.mu.Unlock()
			close(c.msgs)
			return
		}
		m := c.out[0]
		c.out = c.out[1:]
		c.mu.Unlock()
		c.msgs <- m
	}
}

func toolContents(u acpUpdate) []acpToolContent {
	var raw []json.RawMessage
	if json.Unmarshal(u.Content, &raw) != nil {
		return nil
	}
	out := make([]acpToolContent, 0, len(raw))
	for _, r := range raw {
		var tc acpToolContent
		if json.Unmarshal(r, &tc) == nil {
			out = append(out, tc)
		}
	}
	return out
}

// contentText is the text of a content block (or a list of them).
func contentText(raw json.RawMessage) string {
	var b acpContentBlock
	if json.Unmarshal(raw, &b) == nil && b.Type == "text" {
		return b.Text
	}
	var list []acpContentBlock
	if json.Unmarshal(raw, &list) == nil {
		var sb strings.Builder
		for _, b := range list {
			if b.Type == "text" {
				sb.WriteString(b.Text)
			}
		}
		return sb.String()
	}
	return ""
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func newID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
