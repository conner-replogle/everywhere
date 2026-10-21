package harness

// The Agent Client Protocol (agentclientprotocol.com): JSON-RPC 2.0 over an
// agent's stdin and stdout, one message per line. The client (us) opens
// sessions and sends prompts; the agent streams session/update
// notifications and asks the client for permission. Only what the harness
// uses is modeled here; unknown fields and updates are ignored.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
)

// acpVersion is the protocol version this client speaks.
const acpVersion = 1

type rpcMessage struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id,omitempty"`
	Method  string           `json:"method,omitempty"`
	Params  json.RawMessage  `json:"params,omitempty"`
	Result  json.RawMessage  `json:"result,omitempty"`
	Error   *rpcError        `json:"error,omitempty"`
}

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *rpcError) Error() string {
	if len(e.Data) > 0 && string(e.Data) != "null" {
		return fmt.Sprintf("%s: %s", e.Message, e.Data)
	}
	return e.Message
}

// acpConn is a running ACP agent process.
type acpConn struct {
	cmd *exec.Cmd
	in  io.WriteCloser

	wmu     sync.Mutex
	mu      sync.Mutex
	next    int64
	pending map[int64]chan rpcMessage
	// onNotify gets notifications; onRequest answers the agent's requests.
	onNotify  func(method string, params json.RawMessage)
	onRequest func(method string, params json.RawMessage) (any, error)
	done      chan struct{}
	err       error
}

// startACP runs command in dir and reads its messages until it exits.
// Handlers run on the reading goroutine, in order; onRequest may block
// (a permission prompt waits for the user) without holding up replies.
func startACP(command []string, dir string, env []string, onNotify func(string, json.RawMessage), onRequest func(string, json.RawMessage) (any, error)) (*acpConn, error) {
	cmd := exec.Command(command[0], command[1:]...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr := &tailWriter{max: 4 << 10}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	c := &acpConn{cmd: cmd, in: in, pending: map[int64]chan rpcMessage{}, onNotify: onNotify, onRequest: onRequest, done: make(chan struct{})}
	go func() {
		rerr := c.read(out)
		werr := cmd.Wait()
		c.mu.Lock()
		switch {
		case rerr != nil && !errors.Is(rerr, io.EOF):
			c.err = rerr
		case werr != nil:
			c.err = fmt.Errorf("%s exited: %w%s", command[0], werr, stderr.suffix())
		default:
			c.err = fmt.Errorf("%s exited%s", command[0], stderr.suffix())
		}
		for id, ch := range c.pending {
			close(ch)
			delete(c.pending, id)
		}
		c.mu.Unlock()
		close(c.done)
	}()
	return c, nil
}

func (c *acpConn) read(r io.Reader) error {
	br := bufio.NewReaderSize(r, 1<<20)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			c.dispatch(line)
		}
		if err != nil {
			return err
		}
	}
}

func (c *acpConn) dispatch(line []byte) {
	var m rpcMessage
	if json.Unmarshal(line, &m) != nil {
		return
	}
	switch {
	case m.Method != "" && m.ID != nil:
		// A request from the agent: answered on its own goroutine, since a
		// permission request waits on the user.
		go func() {
			res, err := c.onRequest(m.Method, m.Params)
			reply := rpcMessage{ID: m.ID}
			if err != nil {
				reply.Error = &rpcError{Code: -32603, Message: err.Error()}
				var re *rpcError
				if errors.As(err, &re) {
					reply.Error = re
				}
			} else if reply.Result, err = json.Marshal(res); err != nil {
				reply.Error = &rpcError{Code: -32603, Message: err.Error()}
			}
			c.write(reply)
		}()
	case m.Method != "":
		c.onNotify(m.Method, m.Params)
	case m.ID != nil:
		var id int64
		if json.Unmarshal(*m.ID, &id) != nil {
			return
		}
		c.mu.Lock()
		ch := c.pending[id]
		delete(c.pending, id)
		c.mu.Unlock()
		if ch != nil {
			ch <- m
		}
	}
}

func (c *acpConn) write(m rpcMessage) {
	m.JSONRPC = "2.0"
	b, err := json.Marshal(m)
	if err != nil {
		return
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if _, err := c.in.Write(append(b, '\n')); err != nil {
		slog.Debug("acp write", "err", err)
	}
}

// call sends a request and decodes its result into out (if not nil).
func (c *acpConn) call(ctx context.Context, method string, params, out any) error {
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	ch := make(chan rpcMessage, 1)
	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		return err
	}
	c.next++
	id := c.next
	c.pending[id] = ch
	c.mu.Unlock()
	idRaw := json.RawMessage(fmt.Sprint(id))
	c.write(rpcMessage{ID: &idRaw, Method: method, Params: raw})
	select {
	case m, ok := <-ch:
		if !ok {
			return c.exitErr()
		}
		if m.Error != nil {
			return m.Error
		}
		if out == nil || len(m.Result) == 0 {
			return nil
		}
		return json.Unmarshal(m.Result, out)
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return ctx.Err()
	}
}

// notify sends a notification.
func (c *acpConn) notify(method string, params any) {
	raw, err := json.Marshal(params)
	if err != nil {
		return
	}
	c.write(rpcMessage{Method: method, Params: raw})
}

func (c *acpConn) exitErr() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return c.err
	}
	return errors.New("the agent exited")
}

// close stops the process.
func (c *acpConn) close() {
	_ = c.in.Close()
	if c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
	<-c.done
}

// tailWriter keeps the end of what's written to it (an agent's stderr),
// for saying why it exited.
type tailWriter struct {
	mu  sync.Mutex
	max int
	buf []byte
}

func (w *tailWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf = append(w.buf, p...)
	if len(w.buf) > w.max {
		w.buf = w.buf[len(w.buf)-w.max:]
	}
	return len(p), nil
}

func (w *tailWriter) suffix() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	s := strings.TrimSpace(string(w.buf))
	if s == "" {
		return ""
	}
	if i := strings.LastIndex(s, "\n"); i >= 0 && len(s)-i > 0 {
		s = s[i+1:]
	}
	return ": " + s
}

// --- the protocol's messages -------------------------------------------------

type acpInitializeResult struct {
	ProtocolVersion   int `json:"protocolVersion"`
	AgentCapabilities struct {
		LoadSession        bool `json:"loadSession"`
		PromptCapabilities struct {
			Image           bool `json:"image"`
			EmbeddedContext bool `json:"embeddedContext"`
		} `json:"promptCapabilities"`
		MCPCapabilities struct {
			HTTP bool `json:"http"`
		} `json:"mcpCapabilities"`
	} `json:"agentCapabilities"`
	AgentInfo struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	} `json:"agentInfo"`
}

// acpMCPServer is an MCP server a session gets (the HTTP kind).
type acpMCPServer struct {
	Type    string          `json:"type"`
	Name    string          `json:"name"`
	URL     string          `json:"url"`
	Headers []acpHTTPHeader `json:"headers"`
}

type acpHTTPHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// acpSessionResult answers session/new and session/load.
type acpSessionResult struct {
	SessionID     string            `json:"sessionId"`
	ConfigOptions []acpConfigOption `json:"configOptions"`
	Modes         *struct {
		CurrentModeID  string `json:"currentModeId"`
		AvailableModes []struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"availableModes"`
	} `json:"modes"`
}

// acpConfigOption is a session setting the agent offers: a model, a mode.
type acpConfigOption struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Category     string `json:"category"`
	Type         string `json:"type"`
	CurrentValue string `json:"currentValue"`
	Options      []struct {
		Value       string `json:"value"`
		Name        string `json:"name"`
		Description string `json:"description"`
	} `json:"options"`
}

type acpContentBlock struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
	Data     string `json:"data,omitempty"`
}

// acpUpdate is a session/update's update, by SessionUpdate.
type acpUpdate struct {
	SessionUpdate string `json:"sessionUpdate"`
	// agent_message_chunk, agent_thought_chunk, user_message_chunk
	Content json.RawMessage `json:"content"`
	// tool_call, tool_call_update
	ToolCallID string          `json:"toolCallId"`
	Title      *string         `json:"title"`
	Kind       string          `json:"kind"`
	Status     string          `json:"status"`
	RawInput   json.RawMessage `json:"rawInput"`
	RawOutput  json.RawMessage `json:"rawOutput"`
	Locations  []struct {
		Path string `json:"path"`
		Line int    `json:"line"`
	} `json:"locations"`
	// plan
	Entries []struct {
		Content  string `json:"content"`
		Priority string `json:"priority"`
		Status   string `json:"status"`
	} `json:"entries"`
	// available_commands_update
	AvailableCommands []struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Input       *struct {
			Hint string `json:"hint"`
		} `json:"input"`
	} `json:"availableCommands"`
	// current_mode_update
	CurrentModeID string `json:"currentModeId"`
	// config_option_update
	ConfigOptions []acpConfigOption `json:"configOptions"`
	// usage_update
	Used int `json:"used"`
	Size int `json:"size"`
}

// acpToolContent is one item of a tool call's content.
type acpToolContent struct {
	Type    string          `json:"type"` // content | diff | terminal
	Content json.RawMessage `json:"content"`
	Path    string          `json:"path"`
	OldText *string         `json:"oldText"`
	NewText string          `json:"newText"`
}

type acpPermissionRequest struct {
	SessionID string    `json:"sessionId"`
	ToolCall  acpUpdate `json:"toolCall"`
	Options   []struct {
		OptionID string `json:"optionId"`
		Name     string `json:"name"`
		Kind     string `json:"kind"` // allow_once | allow_always | reject_once | reject_always
	} `json:"options"`
}
