package browser

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
)

// errClosed is returned by calls on a connection whose browser has gone.
var errClosed = errors.New("browser: connection closed")

// conn speaks the Chrome DevTools Protocol over --remote-debugging-pipe:
// NUL-terminated JSON messages, with sessions flattened onto the one pipe.
type conn struct {
	w      io.WriteCloser
	wmu    sync.Mutex
	nextID atomic.Int64

	// onEvent is called on the reader goroutine and must not block.
	onEvent func(sessionID, method string, params json.RawMessage)
	// onClose is called once, after pending calls have failed.
	onClose func(error)

	mu      sync.Mutex
	pending map[int64]chan reply
	err     error // set once closed
}

type reply struct {
	result json.RawMessage
	err    error
}

type inbound struct {
	ID        int64           `json:"id"`
	Method    string          `json:"method"`
	Params    json.RawMessage `json:"params"`
	SessionID string          `json:"sessionId"`
	Result    json.RawMessage `json:"result"`
	Error     *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

type outbound struct {
	ID        int64  `json:"id"`
	Method    string `json:"method"`
	Params    any    `json:"params,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
}

func newConn(w io.WriteCloser, r io.Reader, onEvent func(string, string, json.RawMessage), onClose func(error)) *conn {
	c := &conn{w: w, onEvent: onEvent, onClose: onClose, pending: map[int64]chan reply{}}
	go c.read(r)
	return c
}

func (c *conn) read(r io.Reader) {
	br := bufio.NewReaderSize(r, 1<<20)
	for {
		b, err := br.ReadBytes(0)
		if err != nil {
			c.fail(err)
			return
		}
		var m inbound
		if json.Unmarshal(b[:len(b)-1], &m) != nil {
			continue
		}
		if m.ID == 0 {
			if m.Method != "" {
				c.onEvent(m.SessionID, m.Method, m.Params)
			}
			continue
		}
		c.mu.Lock()
		ch := c.pending[m.ID]
		delete(c.pending, m.ID)
		c.mu.Unlock()
		if ch == nil {
			continue
		}
		if m.Error != nil {
			ch <- reply{err: fmt.Errorf("%s (%d)", m.Error.Message, m.Error.Code)}
		} else {
			ch <- reply{result: m.Result}
		}
	}
}

func (c *conn) fail(err error) {
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return
	}
	c.err = errClosed
	pending := c.pending
	c.pending = nil
	c.mu.Unlock()
	for _, ch := range pending {
		ch <- reply{err: errClosed}
	}
	_ = c.w.Close()
	if c.onClose != nil {
		go c.onClose(err)
	}
}

// call sends a command and decodes its result into out (if non-nil).
func (c *conn) call(ctx context.Context, sessionID, method string, params, out any) error {
	id := c.nextID.Add(1)
	b, err := json.Marshal(outbound{ID: id, Method: method, Params: params, SessionID: sessionID})
	if err != nil {
		return err
	}
	ch := make(chan reply, 1)
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return c.err
	}
	c.pending[id] = ch
	c.mu.Unlock()

	c.wmu.Lock()
	_, err = c.w.Write(append(b, 0))
	c.wmu.Unlock()
	if err != nil {
		c.fail(err)
		return errClosed
	}

	select {
	case r := <-ch:
		if r.err != nil {
			return fmt.Errorf("%s: %w", method, r.err)
		}
		if out != nil && len(r.result) > 0 {
			return json.Unmarshal(r.result, out)
		}
		return nil
	case <-ctx.Done():
		c.mu.Lock()
		if c.pending != nil {
			delete(c.pending, id)
		}
		c.mu.Unlock()
		return ctx.Err()
	}
}

func (c *conn) close() { c.fail(errClosed) }
