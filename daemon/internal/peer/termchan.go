package peer

import (
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

const (
	// SCTP messages above this size aren't safe across all browsers.
	maxChunk = 16 * 1024
	// A client this far behind is dropped; reattaching replays scrollback.
	maxBuffered = 4 << 20
)

// termClient adapts a term:<threadId> data channel to term.Client.
type termClient struct {
	s        *Server
	dc       *webrtc.DataChannel
	once     sync.Once
	threadID string

	mu       sync.Mutex
	attached bool
}

func (c *termClient) isAttached() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.attached
}

// detach removes the client from its thread; safe to call more than once.
func (c *termClient) detach() {
	c.mu.Lock()
	was := c.attached
	c.attached = false
	c.mu.Unlock()
	if was {
		c.s.terms.Detach(c.threadID, c)
	}
}

func (c *termClient) Output(p []byte) {
	if c.dc.BufferedAmount() > maxBuffered {
		slog.Warn("terminal client too slow, dropping", "thread", c.threadID)
		go c.close()
		return
	}
	for len(p) > 0 {
		n := min(len(p), maxChunk)
		if err := c.dc.Send(p[:n]); err != nil {
			return
		}
		p = p[n:]
	}
}

func (c *termClient) Writer(you bool) { c.sendJSON(protocol.TermWriter{T: "writer", You: you}) }

// Exited is called after the session has already dropped its clients, so the
// channel may send a fresh attach to start a new shell.
func (c *termClient) Exited(code int) {
	c.mu.Lock()
	c.attached = false
	c.mu.Unlock()
	c.sendJSON(protocol.TermExited{T: "exited", Code: code})
}

func (c *termClient) sendJSON(v any) {
	b, _ := json.Marshal(v)
	_ = c.dc.SendText(string(b))
}

func (c *termClient) close() { c.once.Do(func() { _ = c.dc.Close() }) }

func (s *Server) serveTerm(p *peer, dc *webrtc.DataChannel, threadID string) {
	c := &termClient{s: s, dc: dc, threadID: threadID}
	p.mu.Lock()
	if p.terms == nil { // peer already closed
		p.mu.Unlock()
		_ = dc.Close()
		return
	}
	p.terms[c] = true
	p.mu.Unlock()

	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if !msg.IsString {
			if c.isAttached() {
				s.terms.Input(threadID, c, msg.Data)
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
			if c.attached {
				c.mu.Unlock()
				return
			}
			c.attached = true
			c.mu.Unlock()
			if err := s.terms.Attach(threadID, c, m.Cols, m.Rows); err != nil {
				c.mu.Lock()
				c.attached = false
				c.mu.Unlock()
				c.sendJSON(protocol.TermError{T: "error", Message: err.Error()})
			}
		case "resize":
			s.terms.Resize(threadID, c, m.Cols, m.Rows)
		case "takeover":
			s.terms.Takeover(threadID, c, m.Cols, m.Rows)
		}
	})
	dc.OnClose(func() {
		c.detach()
		p.mu.Lock()
		delete(p.terms, c)
		p.mu.Unlock()
	})
}
