// Package termchan serves the terminal channel protocol (attach, writer,
// takeover, resize, input, exited) for anything that looks like a terminal:
// thread shells (term:) and process output (proc:).
package termchan

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/term"
)

const (
	// MaxChunk: SCTP messages above this size aren't safe across all browsers.
	MaxChunk = 16 * 1024
	// MaxBuffered: a client this far behind is dropped; reattaching replays
	// scrollback.
	MaxBuffered = 4 << 20
)

// Terminals is what a terminal channel drives: thread shells (term.Manager)
// or process output (process.Manager).
type Terminals interface {
	Attach(id string, c term.Client, cols, rows uint16) error
	Detach(id string, c term.Client)
	Input(id string, c term.Client, p []byte)
	Resize(id string, c term.Client, cols, rows uint16)
	Takeover(id string, c term.Client, cols, rows uint16)
}

// client adapts a term:<threadId> or proc:<processId> data channel to
// term.Client.
type client struct {
	terms Terminals
	dc    *webrtc.DataChannel
	once  sync.Once
	id    string // thread or process id

	mu       sync.Mutex
	attached bool
}

func (c *client) isAttached() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.attached
}

// detach removes the client from its terminal; safe to call more than once.
func (c *client) detach() {
	c.mu.Lock()
	was := c.attached
	c.attached = false
	c.mu.Unlock()
	if was {
		c.terms.Detach(c.id, c)
	}
}

func (c *client) Output(p []byte) {
	if c.dc.BufferedAmount() > MaxBuffered {
		slog.Warn("terminal client too slow, dropping", "id", c.id)
		go c.close()
		return
	}
	for len(p) > 0 {
		n := min(len(p), MaxChunk)
		if err := c.dc.Send(p[:n]); err != nil {
			return
		}
		p = p[n:]
	}
}

func (c *client) Writer(you bool) { c.sendJSON(protocol.TermWriter{T: "writer", You: you}) }

// Exited is called after the session has already dropped its clients, so the
// channel may send a fresh attach to start a new shell.
func (c *client) Exited(code int) {
	c.mu.Lock()
	c.attached = false
	c.mu.Unlock()
	c.sendJSON(protocol.TermExited{T: "exited", Code: code})
}

func (c *client) sendJSON(v any) {
	b, _ := json.Marshal(v)
	_ = c.dc.SendText(string(b))
}

func (c *client) close() { c.once.Do(func() { _ = c.dc.Close() }) }

// Serve serves one terminal channel for id until ctx ends.
func Serve(ctx context.Context, dc *webrtc.DataChannel, id string, terms Terminals) {
	c := &client{terms: terms, dc: dc, id: id}
	go func() {
		<-ctx.Done()
		c.detach()
	}()
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if !msg.IsString {
			if c.isAttached() {
				terms.Input(id, c, msg.Data)
			}
			return
		}
		var m protocol.TermClientMsg
		if err := json.Unmarshal(msg.Data, &m); err != nil {
			return
		}
		switch m.T {
		case "attach":
			c.mu.Lock()
			if c.attached || ctx.Err() != nil {
				c.mu.Unlock()
				return
			}
			c.attached = true
			c.mu.Unlock()
			if err := terms.Attach(id, c, m.Cols, m.Rows); err != nil {
				c.mu.Lock()
				c.attached = false
				c.mu.Unlock()
				c.sendJSON(protocol.TermError{T: "error", Message: err.Error()})
			}
		case "resize":
			terms.Resize(id, c, m.Cols, m.Rows)
		case "takeover":
			terms.Takeover(id, c, m.Cols, m.Rows)
		}
	})
}
