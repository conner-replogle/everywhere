package external

// The plugin process protocol: JSON-RPC 2.0, one message per line, over the
// process's stdin (from the daemon) and stdout (to it). stderr goes to the
// daemon's log.
//
// The daemon asks (requests answer; notifications don't):
//
//	initialize    {api, id, host: {version, device}, dataDir, settings}  → {api}
//	rpc           {method, params, remote}                   → the method's result
//	tool          {name, args, threadId}                     → {content: [{type: text|image, …}], isError?} | {text}
//	session.open  {session, kind, offer, params}             → {answer}
//	notifications: session.candidate {session, candidate}, session.closed {session},
//	               channel.open {stream, label, rest}, channel.message {stream, text | data (base64)},
//	               channel.close {stream}, kind.created {thread, params}, kind.deleted {thread},
//	               event {topic, payload}, config {settings} (they changed), shutdown
//
// The plugin asks (all requests), checked against its permissions:
//
//	host.emit            {event}                      an event to browsers; event.event starts with "<id>."
//	host.channel.send    {stream, text | data}
//	host.channel.close   {stream}
//	host.session.candidate {session, candidate}
//	host.session.close   {session, reason?}
//	host.threads.get     {id}       (agent.read for claude threads' content; this is just the row)
//	host.threads.workdir {id}
//	host.agent.notify    {threadId, name, text, prompt?, wake?}   needs agent.notify
//	host.agent.send      {threadId, text}                          needs agent.notify
//	host.config.get      {}         its settings: each value, or its default
//	host.kv.get | set | delete | list | scopes   {scope, key, value?, prefix?}
//	                     its own key/value state ("" or "thread:<id>" / "project:<id>",
//	                     deleted with them); changes reach its web part as <id>.kv.changed
//	host.log             {level, message}

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

// maxLine caps one message (a tool's image, a channel's chunk).
const maxLine = 32 << 20

type message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int64          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string { return e.Message }

// conn is one plugin process's JSON-RPC connection.
type conn struct {
	w   io.Writer
	wmu sync.Mutex

	mu      sync.Mutex
	next    int64
	pending map[int64]chan message
	done    chan struct{}
	err     error

	// handle answers the plugin's requests.
	handle func(method string, params json.RawMessage) (any, error)
}

func newConn(w io.Writer, handle func(string, json.RawMessage) (any, error)) *conn {
	return &conn{w: w, pending: map[int64]chan message{}, done: make(chan struct{}), handle: handle}
}

func (c *conn) write(m message) error {
	m.JSONRPC = "2.0"
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, err = c.w.Write(append(b, '\n'))
	return err
}

// call sends a request and waits for its answer.
func (c *conn) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	ch := make(chan message, 1)
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return nil, c.err
	}
	c.next++
	id := c.next
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()
	if err := c.write(message{ID: &id, Method: method, Params: raw}); err != nil {
		return nil, err
	}
	select {
	case m := <-ch:
		if m.Error != nil {
			return nil, m.Error
		}
		return m.Result, nil
	case <-c.done:
		return nil, c.closedErr()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// notify sends a notification.
func (c *conn) notify(method string, params any) {
	raw, err := json.Marshal(params)
	if err != nil {
		return
	}
	_ = c.write(message{Method: method, Params: raw})
}

func (c *conn) closedErr() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return c.err
	}
	return errors.New("the plugin stopped")
}

// serve reads messages until r ends.
func (c *conn) serve(r io.Reader) error {
	br := bufio.NewReaderSize(r, 64<<10)
	var err error
	for {
		var line []byte
		line, err = readLine(br)
		if err != nil {
			break
		}
		if len(line) == 0 {
			continue
		}
		var m message
		if json.Unmarshal(line, &m) != nil {
			continue
		}
		switch {
		case m.Method != "" && m.ID != nil:
			go c.answer(m)
		case m.Method != "":
			go func() { _, _ = c.handle(m.Method, m.Params) }()
		case m.ID != nil:
			c.mu.Lock()
			ch := c.pending[*m.ID]
			c.mu.Unlock()
			if ch != nil {
				ch <- m
			}
		}
	}
	c.mu.Lock()
	if errors.Is(err, io.EOF) {
		err = errors.New("the plugin stopped")
	}
	c.err = err
	c.mu.Unlock()
	close(c.done)
	return err
}

func (c *conn) answer(m message) {
	res, err := c.handle(m.Method, m.Params)
	out := message{ID: m.ID}
	if err != nil {
		out.Error = &rpcError{Code: -32000, Message: err.Error()}
	} else if out.Result, err = json.Marshal(res); err != nil {
		out.Result, out.Error = nil, &rpcError{Code: -32603, Message: err.Error()}
	}
	_ = c.write(out)
}

func readLine(br *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, isPrefix, err := br.ReadLine()
		if err != nil {
			return nil, err
		}
		line = append(line, chunk...)
		if len(line) > maxLine {
			return nil, fmt.Errorf("a message over %d MB", maxLine>>20)
		}
		if !isPrefix {
			return line, nil
		}
	}
}
