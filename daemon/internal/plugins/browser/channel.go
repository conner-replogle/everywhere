package browser

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/browser"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/termchan"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// browserClient adapts a browser:<threadId> data channel to browser.Client.
type browserClient struct {
	m    *browser.Manager
	dc   *webrtc.DataChannel
	once sync.Once
	key  string

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
		n := min(len(jpeg), termchan.MaxChunk)
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
		c.m.Detach(c.key, c)
	}
}

func (c *browserClient) close() { c.once.Do(func() { _ = c.dc.Close() }) }

// serveChannel serves a browser:<key> channel until ctx ends.
func serveChannel(ctx context.Context, m *browser.Manager, dc *webrtc.DataChannel, key string) {
	c := &browserClient{m: m, dc: dc, key: key}
	go func() {
		<-ctx.Done()
		c.mu.Lock()
		c.gone = true
		c.mu.Unlock()
		c.detach()
	}()

	var attaching sync.Once
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var cm protocol.BrowserClientMsg
		if !msg.IsString || json.Unmarshal(msg.Data, &cm) != nil {
			return
		}
		if cm.T == "attach" {
			// Starting the browser takes a moment; don't hold up the channel.
			attaching.Do(func() {
				go func() {
					if err := m.Attach(context.Background(), key, c, browser.ViewportOf(cm)); err != nil {
						c.Send(protocol.BrowserError{T: "error", Message: err.Error()})
						return
					}
					c.mu.Lock()
					gone := c.gone
					c.attached = !gone
					if !gone {
						// Under the lock, so later messages can't overtake these.
						for _, e := range c.early {
							m.Handle(key, c, e)
						}
					}
					c.early = nil
					c.mu.Unlock()
					if gone { // closed while the browser was starting
						m.Detach(key, c)
					}
				}()
			})
			return
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		switch {
		case c.attached:
			m.Handle(key, c, cm)
		case len(c.early) < maxEarly:
			c.early = append(c.early, cm)
		}
	})
}
