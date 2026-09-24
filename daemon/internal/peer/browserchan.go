package peer

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/browser"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// browserClient adapts a browser:<projectId> data channel to browser.Client.
type browserClient struct {
	s         *Server
	dc        *webrtc.DataChannel
	once      sync.Once
	projectID string

	mu       sync.Mutex
	attached bool
	gone     bool                        // the channel has closed
	early    []protocol.BrowserClientMsg // sent while the browser was starting
	sendMu   sync.Mutex                  // keeps a frame's header and chunks together
}

// Messages kept while attaching; a client that sends more is misbehaving.
const maxEarly = 256

func (c *browserClient) Frame(hdr protocol.BrowserFrame, jpeg []byte) {
	b, _ := json.Marshal(hdr)
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	if c.dc.SendText(string(b)) != nil {
		return
	}
	for len(jpeg) > 0 {
		n := min(len(jpeg), maxChunk)
		if c.dc.Send(jpeg[:n]) != nil {
			return
		}
		jpeg = jpeg[n:]
	}
}

func (c *browserClient) Send(msg any) {
	b, err := json.Marshal(msg)
	if err != nil {
		return
	}
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	_ = c.dc.SendText(string(b))
}

func (c *browserClient) Buffered() uint64 { return c.dc.BufferedAmount() }

func (c *browserClient) Closed(reason string) {
	c.mu.Lock()
	c.attached = false
	c.mu.Unlock()
	if reason != "" {
		c.Send(protocol.BrowserError{T: "error", Message: reason})
	}
	go c.close()
}

// detach removes the client from its tab; safe to call more than once.
func (c *browserClient) detach() {
	c.mu.Lock()
	was := c.attached
	c.attached = false
	c.mu.Unlock()
	if was {
		c.s.browsers.Detach(c.projectID, c)
	}
}

func (c *browserClient) close() { c.once.Do(func() { _ = c.dc.Close() }) }

func (s *Server) serveBrowser(p *peer, dc *webrtc.DataChannel, projectID string) {
	if _, err := s.store.GetProject(projectID); err != nil {
		_ = dc.Close()
		return
	}
	c := &browserClient{s: s, dc: dc, projectID: projectID}
	p.mu.Lock()
	if p.browsers == nil { // peer already closed
		p.mu.Unlock()
		_ = dc.Close()
		return
	}
	p.browsers[c] = true
	p.mu.Unlock()

	var attaching sync.Once
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var m protocol.BrowserClientMsg
		if !msg.IsString || json.Unmarshal(msg.Data, &m) != nil {
			return
		}
		if m.T == "attach" {
			// Starting the browser takes a moment; don't hold up the channel.
			attaching.Do(func() {
				go func() {
					if err := s.browsers.Attach(context.Background(), projectID, c, browser.ViewportOf(m)); err != nil {
						c.Send(protocol.BrowserError{T: "error", Message: err.Error()})
						return
					}
					c.mu.Lock()
					gone := c.gone
					c.attached = !gone
					if !gone {
						// Under the lock, so later messages can't overtake these.
						for _, m := range c.early {
							s.browsers.Handle(projectID, c, m)
						}
					}
					c.early = nil
					c.mu.Unlock()
					if gone { // closed while the browser was starting
						s.browsers.Detach(projectID, c)
					}
				}()
			})
			return
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		switch {
		case c.attached:
			s.browsers.Handle(projectID, c, m)
		case len(c.early) < maxEarly:
			c.early = append(c.early, m)
		}
	})
	dc.OnClose(func() {
		c.mu.Lock()
		c.gone = true
		c.mu.Unlock()
		c.detach()
		p.mu.Lock()
		delete(p.browsers, c)
		p.mu.Unlock()
	})
}
