// Package plugin is the Go SDK for everywhere plugins: a program the
// daemon runs, speaking JSON-RPC over stdin/stdout (see the daemon's
// internal/plugin/external/protocol.go). Declare what the plugin serves in
// its plugin.json, register handlers for it here, and call Run.
//
//	p := plugin.New()
//	p.Method("hello.greet", func(ctx context.Context, c plugin.Call) (any, error) {
//		var a struct{ Name string }
//		_ = c.Decode(&a)
//		return "Hello, " + a.Name, nil
//	})
//	p.Tool("greet", func(ctx context.Context, c plugin.ToolCall) (string, error) { … })
//	log.Fatal(p.Run())
package plugin

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
)

// API is the plugin API revision this SDK speaks.
const API = 1

// Call is a control method's call.
type Call struct {
	Method string
	Params json.RawMessage
	// Remote: it came from an agent connected to the account (MCP), not a browser.
	Remote bool
}

// Decode decodes the call's params.
func (c Call) Decode(v any) error {
	if len(c.Params) == 0 || string(c.Params) == "null" {
		return nil
	}
	return json.Unmarshal(c.Params, v)
}

// ToolCall is a claude thread calling one of the plugin's tools.
type ToolCall struct {
	Name     string
	Args     json.RawMessage
	ThreadID string
}

// Decode decodes the tool's arguments.
func (c ToolCall) Decode(v any) error { return json.Unmarshal(c.Args, v) }

// Stream is a data channel a browser opened with one of the plugin's prefixes.
type Stream struct {
	p     *Plugin
	ID    string
	Label string
	// Rest is the label after the plugin's prefix.
	Rest string

	mu      sync.Mutex
	onText  func(string)
	onBytes func([]byte)
	onClose func()
}

// OnText sets what to do with text messages.
func (s *Stream) OnText(fn func(string)) { s.mu.Lock(); s.onText = fn; s.mu.Unlock() }

// OnBytes sets what to do with binary messages.
func (s *Stream) OnBytes(fn func([]byte)) { s.mu.Lock(); s.onBytes = fn; s.mu.Unlock() }

// OnClose sets what to do when the browser closes it.
func (s *Stream) OnClose(fn func()) { s.mu.Lock(); s.onClose = fn; s.mu.Unlock() }

// SendText sends a text message.
func (s *Stream) SendText(text string) error {
	_, err := s.p.call(context.Background(), "host.channel.send", map[string]any{"stream": s.ID, "text": text})
	return err
}

// SendBytes sends a binary message.
func (s *Stream) SendBytes(b []byte) error {
	_, err := s.p.call(context.Background(), "host.channel.send", map[string]any{"stream": s.ID, "data": base64.StdEncoding.EncodeToString(b)})
	return err
}

// Close closes it.
func (s *Stream) Close() error {
	_, err := s.p.call(context.Background(), "host.channel.close", map[string]any{"stream": s.ID})
	return err
}

// Init is what the daemon says when it starts the plugin.
type Init struct {
	API     int             `json:"api"`
	ID      string          `json:"id"`
	DataDir string          `json:"dataDir"`
	Host    json.RawMessage `json:"host"`
	// Settings are its settings' values (or defaults) at start.
	Settings map[string]json.RawMessage `json:"settings"`
}

// Plugin is a plugin's side of the connection.
type Plugin struct {
	methods map[string]func(context.Context, Call) (any, error)
	tools   map[string]func(context.Context, ToolCall) (string, error)
	stream  func(*Stream)
	event   func(topic string, payload json.RawMessage)
	kind    func(event string, thread json.RawMessage)
	config  func(map[string]json.RawMessage)
	// Init is set once the daemon has said hello.
	Init Init

	settingsMu sync.Mutex
	settings   map[string]json.RawMessage

	in  io.Reader
	out io.Writer

	wmu     sync.Mutex
	mu      sync.Mutex
	next    int64
	pending map[int64]chan reply
	streams map[string]*Stream
	done    chan struct{}
}

type message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

// Error is an error from the other side.
type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Message }

type reply struct {
	result json.RawMessage
	err    error
}

// New makes a plugin on stdin and stdout. Log to stderr: the daemon logs it.
func New() *Plugin { return NewIO(os.Stdin, os.Stdout) }

// NewIO makes a plugin on other streams, for tests.
func NewIO(in io.Reader, out io.Writer) *Plugin {
	return &Plugin{
		methods: map[string]func(context.Context, Call) (any, error){},
		tools:   map[string]func(context.Context, ToolCall) (string, error){},
		in:      in, out: out,
		pending: map[int64]chan reply{},
		streams: map[string]*Stream{},
		done:    make(chan struct{}),
	}
}

// Method serves a control method (declared in plugin.json's contributes.rpc).
func (p *Plugin) Method(name string, fn func(context.Context, Call) (any, error)) {
	p.methods[name] = fn
}

// Tool serves a tool for claude (declared in contributes.tools), answering with text.
func (p *Plugin) Tool(name string, fn func(context.Context, ToolCall) (string, error)) {
	p.tools[name] = fn
}

// Streams handles data channels browsers open (contributes.channels).
func (p *Plugin) Streams(fn func(*Stream)) { p.stream = fn }

// Events handles the bus events the plugin listens to (contributes.events).
func (p *Plugin) Events(fn func(topic string, payload json.RawMessage)) { p.event = fn }

// Kinds handles its tab kinds being created ("created") and deleted ("deleted").
func (p *Plugin) Kinds(fn func(event string, thread json.RawMessage)) { p.kind = fn }

// OnSettings is called with its settings when the user changes them.
func (p *Plugin) OnSettings(fn func(map[string]json.RawMessage)) { p.config = fn }

// Setting decodes one setting's current value (or default) into v; false if
// it has neither.
func (p *Plugin) Setting(key string, v any) bool {
	p.settingsMu.Lock()
	raw, ok := p.settings[key]
	p.settingsMu.Unlock()
	return ok && json.Unmarshal(raw, v) == nil
}

// KV is the plugin's key/value state on the device. scope is "" (the
// plugin's), "thread:<id>" or "project:<id>" (deleted with them). Changes
// reach its web part as "<id>.kv.changed".
type KV struct{ p *Plugin }

// KV gives the plugin's key/value state.
func (p *Plugin) KV() KV { return KV{p} }

// Get decodes a key's value into v; false if it isn't set.
func (k KV) Get(scope, key string, v any) (bool, error) {
	raw, err := k.p.call(context.Background(), "host.kv.get", map[string]any{"scope": scope, "key": key})
	if err != nil {
		return false, err
	}
	var r struct {
		Found bool            `json:"found"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(raw, &r); err != nil || !r.Found {
		return false, err
	}
	return true, json.Unmarshal(r.Value, v)
}

// Set sets a key to v (as JSON).
func (k KV) Set(scope, key string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = k.p.call(context.Background(), "host.kv.set", map[string]any{"scope": scope, "key": key, "value": json.RawMessage(b)})
	return err
}

// Delete removes a key.
func (k KV) Delete(scope, key string) error {
	_, err := k.p.call(context.Background(), "host.kv.delete", map[string]any{"scope": scope, "key": key})
	return err
}

// Entry is one key of a List.
type Entry struct {
	Scope string          `json:"scope"`
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value"`
}

// List lists a scope's keys starting with prefix.
func (k KV) List(scope, prefix string) ([]Entry, error) {
	raw, err := k.p.call(context.Background(), "host.kv.list", map[string]any{"scope": scope, "prefix": prefix})
	if err != nil {
		return nil, err
	}
	var out []Entry
	return out, json.Unmarshal(raw, &out)
}

// Scopes lists the scopes it has keys in starting with prefix ("thread:").
func (k KV) Scopes(prefix string) ([]string, error) {
	raw, err := k.p.call(context.Background(), "host.kv.scopes", map[string]any{"prefix": prefix})
	if err != nil {
		return nil, err
	}
	var out []string
	return out, json.Unmarshal(raw, &out)
}

// Emit sends an event to every browser; its "event" must start with the plugin's id and a dot.
func (p *Plugin) Emit(event any) error {
	_, err := p.call(context.Background(), "host.emit", map[string]any{"event": event})
	return err
}

// Thread decodes a thread (or tab), with its live fields, into v.
func (p *Plugin) Thread(id string, v any) error {
	raw, err := p.call(context.Background(), "host.threads.get", map[string]any{"id": id})
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, v)
}

// Workdir is where a thread works.
func (p *Plugin) Workdir(threadID string) (string, error) {
	raw, err := p.call(context.Background(), "host.threads.workdir", map[string]any{"id": threadID})
	if err != nil {
		return "", err
	}
	var w struct {
		Path string `json:"path"`
	}
	return w.Path, json.Unmarshal(raw, &w)
}

// NotifyAgent tells a thread's claude something (needs agent.notify): wake
// starts a turn now; otherwise it goes with the next prompt.
func (p *Plugin) NotifyAgent(threadID, name, text string, wake bool) error {
	_, err := p.call(context.Background(), "host.agent.notify", map[string]any{"threadId": threadID, "name": name, "text": text, "wake": wake})
	return err
}

// Log writes to the daemon's log.
func (p *Plugin) Log(level, format string, a ...any) {
	_, _ = p.call(context.Background(), "host.log", map[string]any{"level": level, "message": fmt.Sprintf(format, a...)})
}

// Run serves until the daemon closes stdin or says shutdown.
func (p *Plugin) Run() error {
	br := bufio.NewReaderSize(p.in, 64<<10)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			var m message
			if json.Unmarshal(line, &m) == nil {
				if m.Method == "shutdown" {
					close(p.done)
					return nil
				}
				p.dispatch(m)
			}
		}
		if err != nil {
			close(p.done)
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func (p *Plugin) dispatch(m message) {
	if m.Method == "" {
		if m.ID == nil {
			return
		}
		p.mu.Lock()
		ch := p.pending[*m.ID]
		p.mu.Unlock()
		if ch != nil {
			if m.Error != nil {
				ch <- reply{err: m.Error}
			} else {
				ch <- reply{result: m.Result}
			}
		}
		return
	}
	go func() {
		res, err := p.handle(m.Method, m.Params)
		if m.ID == nil {
			return
		}
		out := message{ID: m.ID}
		if err != nil {
			out.Error = &Error{Code: -32000, Message: err.Error()}
		} else if out.Result, err = json.Marshal(res); err != nil {
			out.Error = &Error{Code: -32603, Message: err.Error()}
		}
		p.write(out)
	}()
}

func (p *Plugin) handle(method string, raw json.RawMessage) (any, error) {
	ctx := context.Background()
	switch method {
	case "initialize":
		if err := json.Unmarshal(raw, &p.Init); err != nil {
			return nil, err
		}
		p.settingsMu.Lock()
		p.settings = p.Init.Settings
		p.settingsMu.Unlock()
		return map[string]int{"api": API}, nil
	case "config":
		var a struct {
			Settings map[string]json.RawMessage `json:"settings"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		p.settingsMu.Lock()
		p.settings = a.Settings
		p.settingsMu.Unlock()
		if p.config != nil {
			p.config(a.Settings)
		}
	case "rpc":
		var a struct {
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Remote bool            `json:"remote"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		fn := p.methods[a.Method]
		if fn == nil {
			return nil, fmt.Errorf("unknown method %q", a.Method)
		}
		return fn(ctx, Call{Method: a.Method, Params: a.Params, Remote: a.Remote})
	case "tool":
		var a struct {
			Name     string          `json:"name"`
			Args     json.RawMessage `json:"args"`
			ThreadID string          `json:"threadId"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		fn := p.tools[a.Name]
		if fn == nil {
			return nil, fmt.Errorf("unknown tool %q", a.Name)
		}
		text, err := fn(ctx, ToolCall(a))
		if err != nil {
			return map[string]any{"text": err.Error(), "isError": true}, nil
		}
		return map[string]any{"text": text}, nil
	case "channel.open":
		var a struct{ Stream, Label, Rest string }
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		s := &Stream{p: p, ID: a.Stream, Label: a.Label, Rest: a.Rest}
		p.mu.Lock()
		p.streams[a.Stream] = s
		p.mu.Unlock()
		if p.stream != nil {
			p.stream(s)
		}
	case "channel.message":
		var a struct {
			Stream string  `json:"stream"`
			Text   *string `json:"text"`
			Data   string  `json:"data"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		p.mu.Lock()
		s := p.streams[a.Stream]
		p.mu.Unlock()
		if s == nil {
			return nil, nil
		}
		s.mu.Lock()
		onText, onBytes := s.onText, s.onBytes
		s.mu.Unlock()
		if a.Text != nil && onText != nil {
			onText(*a.Text)
		} else if a.Text == nil && onBytes != nil {
			if b, err := base64.StdEncoding.DecodeString(a.Data); err == nil {
				onBytes(b)
			}
		}
	case "channel.close":
		var a struct{ Stream string }
		_ = json.Unmarshal(raw, &a)
		p.mu.Lock()
		s := p.streams[a.Stream]
		delete(p.streams, a.Stream)
		p.mu.Unlock()
		if s != nil {
			s.mu.Lock()
			fn := s.onClose
			s.mu.Unlock()
			if fn != nil {
				fn()
			}
		}
	case "event":
		var a struct {
			Topic   string          `json:"topic"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal(raw, &a); err == nil && p.event != nil {
			p.event(a.Topic, a.Payload)
		}
	case "kind.created", "kind.deleted":
		var a struct {
			Thread json.RawMessage `json:"thread"`
		}
		if err := json.Unmarshal(raw, &a); err == nil && p.kind != nil {
			p.kind(method[len("kind."):], a.Thread)
		}
	default:
		return nil, fmt.Errorf("unknown method %q", method)
	}
	return struct{}{}, nil
}

func (p *Plugin) write(m message) {
	m.JSONRPC = "2.0"
	b, err := json.Marshal(m)
	if err != nil {
		return
	}
	p.wmu.Lock()
	defer p.wmu.Unlock()
	_, _ = p.out.Write(append(b, '\n'))
}

func (p *Plugin) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	ch := make(chan reply, 1)
	p.mu.Lock()
	p.next++
	id := p.next
	p.pending[id] = ch
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		delete(p.pending, id)
		p.mu.Unlock()
	}()
	p.write(message{ID: &id, Method: method, Params: raw})
	select {
	case r := <-ch:
		return r.result, r.err
	case <-p.done:
		return nil, errors.New("the daemon closed the connection")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
