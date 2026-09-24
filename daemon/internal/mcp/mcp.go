// Package mcp is a small Model Context Protocol server over the Streamable
// HTTP transport, answering with plain JSON (never SSE). The daemon uses it
// to give the claude processes it starts tools of its own, like driving the
// thread's browser tab. Each process gets a bearer token that identifies
// its thread, so tools act on the caller's thread.
//
// Spec: https://modelcontextprotocol.io/specification/2025-06-18
package mcp

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Protocol versions this server speaks, newest first.
var protocolVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

// Path is where the server answers.
const Path = "/mcp"

const maxBody = 4 << 20

// Caller identifies who a token was granted to.
type Caller struct {
	ThreadID string
	// Browser is the key of the browser tab its tools drive: the thread,
	// or for a tab, the thread it belongs to.
	Browser string
}

// Tool is one callable tool.
type Tool struct {
	Name        string
	Title       string
	Description string
	// InputSchema is a JSON Schema object for the arguments.
	InputSchema json.RawMessage
	Annotations Annotations
	// Call runs the tool. A returned error becomes a result with isError set,
	// so the model sees it; protocol errors are for the protocol.
	Call func(ctx context.Context, c Caller, args json.RawMessage) (*Result, error)
}

// Annotations are hints about a tool's behaviour.
type Annotations struct {
	ReadOnly    bool
	Destructive bool
	Idempotent  bool
	OpenWorld   bool
}

// Result is a tool's output.
type Result struct {
	Content []Content `json:"content"`
	IsError bool      `json:"isError,omitempty"`
}

// Content is a text or image block.
type Content struct {
	Type     string `json:"type"` // text | image
	Text     string `json:"text,omitempty"`
	Data     string `json:"data,omitempty"` // base64
	MIMEType string `json:"mimeType,omitempty"`
}

// Text is a result with one text block.
func Text(s string) *Result { return &Result{Content: []Content{{Type: "text", Text: s}}} }

// JSON is a result with v as indented JSON text.
func JSON(v any) (*Result, error) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return nil, err
	}
	return Text(string(b)), nil
}

// Image appends an image block.
func (r *Result) Image(data []byte, mimeType string) *Result {
	r.Content = append(r.Content, Content{Type: "image", Data: base64.StdEncoding.EncodeToString(data), MIMEType: mimeType})
	return r
}

// Server serves a fixed set of tools to token holders.
type Server struct {
	Name, Version string

	tools []Tool
	byKey map[string]*Tool

	mu     sync.Mutex
	tokens map[string]Caller
	ln     net.Listener
	srv    *http.Server
	closed bool
}

func NewServer(name, version string, tools []Tool) *Server {
	s := &Server{Name: name, Version: version, tools: tools, byKey: map[string]*Tool{}, tokens: map[string]Caller{}}
	for i := range s.tools {
		s.byKey[s.tools[i].Name] = &s.tools[i]
	}
	return s
}

// Grant issues a token for c and returns the server's URL, starting it on a
// loopback port on first use. release revokes the token.
func (s *Server) Grant(c Caller) (endpoint, token string, release func(), err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return "", "", nil, errors.New("mcp: server closed")
	}
	if s.ln == nil {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return "", "", nil, fmt.Errorf("mcp: listen: %w", err)
		}
		s.ln = ln
		s.srv = &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second}
		go func() {
			if err := s.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
				slog.Warn("mcp server stopped", "err", err)
			}
		}()
	}
	token = s.addTokenLocked(c)
	var once sync.Once
	release = func() { once.Do(func() { s.Revoke(token) }) }
	return "http://" + s.ln.Addr().String() + Path, token, release, nil
}

// AddToken issues a token for c without starting a listener, for serving
// the handler some other way.
func (s *Server) AddToken(c Caller) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.addTokenLocked(c)
}

func (s *Server) addTokenLocked(c Caller) string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	token := base64.RawURLEncoding.EncodeToString(b)
	s.tokens[token] = c
	return token
}

func (s *Server) Revoke(token string) {
	s.mu.Lock()
	delete(s.tokens, token)
	s.mu.Unlock()
}

// Close stops the listener, if any.
func (s *Server) Close() {
	s.mu.Lock()
	s.closed = true
	srv := s.srv
	s.mu.Unlock()
	if srv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}
}

// ServeHTTP implements the Streamable HTTP transport's POST side. There's
// nothing to stream, so GET (the server-to-client stream) is refused.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !loopbackOrigin(r.Header.Get("Origin")) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if r.URL.Path != Path {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	caller, ok := s.auth(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
		return
	}
	body = bytes.TrimSpace(body)

	var out any
	if len(body) > 0 && body[0] == '[' { // a batch, as 2025-03-26 allows
		var reqs []json.RawMessage
		if json.Unmarshal(body, &reqs) != nil || len(reqs) == 0 {
			writeJSON(w, errResponse(nil, codeInvalidRequest, "invalid batch"))
			return
		}
		var resps []*response
		for _, raw := range reqs {
			if resp := s.handle(r.Context(), caller, raw); resp != nil {
				resps = append(resps, resp)
			}
		}
		if len(resps) > 0 {
			out = resps
		}
	} else if resp := s.handle(r.Context(), caller, body); resp != nil {
		out = resp
	}
	if out == nil { // only notifications or responses
		w.WriteHeader(http.StatusAccepted)
		return
	}
	writeJSON(w, out)
}

func (s *Server) auth(r *http.Request) (Caller, bool) {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || token == "" {
		return Caller{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.tokens[token]
	return c, ok
}

// loopbackOrigin allows requests from non-browsers (no Origin) and from
// pages on this machine, against DNS rebinding.
func loopbackOrigin(origin string) bool {
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

const (
	codeParse          = -32700
	codeInvalidRequest = -32600
	codeNoMethod       = -32601
	codeInvalidParams  = -32602
)

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func errResponse(id json.RawMessage, code int, msg string) *response {
	if id == nil {
		id = json.RawMessage("null")
	}
	return &response{JSONRPC: "2.0", ID: id, Error: &rpcError{code, msg}}
}

// handle answers one message; nil for notifications and client responses.
func (s *Server) handle(ctx context.Context, c Caller, raw json.RawMessage) *response {
	var req request
	if err := json.Unmarshal(raw, &req); err != nil {
		return errResponse(nil, codeParse, "parse error")
	}
	if req.Method == "" { // a response to a request we never send
		return nil
	}
	if req.ID == nil || string(req.ID) == "null" {
		return nil // notifications/initialized, cancelled, ...: nothing to do
	}
	if req.JSONRPC != "2.0" {
		return errResponse(req.ID, codeInvalidRequest, "jsonrpc must be 2.0")
	}
	result, rerr := s.dispatch(ctx, c, req)
	if rerr != nil {
		return &response{JSONRPC: "2.0", ID: req.ID, Error: rerr}
	}
	return &response{JSONRPC: "2.0", ID: req.ID, Result: result}
}

func (s *Server) dispatch(ctx context.Context, c Caller, req request) (any, *rpcError) {
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &p)
		version := protocolVersions[0]
		for _, v := range protocolVersions {
			if v == p.ProtocolVersion {
				version = v
			}
		}
		return map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]string{"name": s.Name, "version": s.Version},
		}, nil
	case "ping":
		return struct{}{}, nil
	case "tools/list":
		tools := make([]map[string]any, 0, len(s.tools))
		for _, t := range s.tools {
			tools = append(tools, map[string]any{
				"name":        t.Name,
				"title":       t.Title,
				"description": t.Description,
				"inputSchema": t.InputSchema,
				"annotations": annotationsJSON(t),
			})
		}
		return map[string]any{"tools": tools}, nil
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, &rpcError{codeInvalidParams, "invalid params"}
		}
		t := s.byKey[p.Name]
		if t == nil {
			return nil, &rpcError{codeInvalidParams, "unknown tool " + p.Name}
		}
		if len(p.Arguments) == 0 || string(p.Arguments) == "null" {
			p.Arguments = json.RawMessage("{}")
		}
		res, err := s.call(ctx, t, c, p.Arguments)
		if err != nil {
			res = &Result{Content: []Content{{Type: "text", Text: err.Error()}}, IsError: true}
		}
		if res.Content == nil {
			res.Content = []Content{}
		}
		return res, nil
	}
	return nil, &rpcError{codeNoMethod, "method not found: " + req.Method}
}

// call runs a tool, turning a panic into an error so one bad call doesn't
// take the daemon down.
func (s *Server) call(ctx context.Context, t *Tool, c Caller, args json.RawMessage) (res *Result, err error) {
	defer func() {
		if p := recover(); p != nil {
			slog.Error("mcp tool panicked", "tool", t.Name, "panic", p)
			res, err = nil, fmt.Errorf("internal error in %s", t.Name)
		}
	}()
	res, err = t.Call(ctx, c, args)
	if err == nil && res == nil {
		res = &Result{}
	}
	return res, err
}

// annotationsJSON states every hint: the spec's defaults for missing ones
// are the cautious values (destructive, open world), not false.
func annotationsJSON(t Tool) map[string]any {
	a := t.Annotations
	return map[string]any{
		"title":           t.Title,
		"readOnlyHint":    a.ReadOnly,
		"destructiveHint": a.Destructive,
		"idempotentHint":  a.Idempotent,
		"openWorldHint":   a.OpenWorld,
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
