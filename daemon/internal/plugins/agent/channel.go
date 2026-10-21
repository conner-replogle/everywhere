package agent

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/agent"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/termchan"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// client adapts an agent:<threadId> data channel to agent.Client.
type client struct {
	m        *agent.Manager
	dc       *webrtc.DataChannel
	once     sync.Once
	threadID string

	mu       sync.Mutex
	attached bool
}

func (c *client) Send(frame any) {
	if c.dc.BufferedAmount() > termchan.MaxBuffered {
		slog.Warn("agent client too slow, dropping", "thread", c.threadID)
		go c.close()
		return
	}
	b, err := json.Marshal(frame)
	if err != nil {
		return
	}
	_ = c.dc.SendText(string(b))
}

// detach removes the client from its thread; safe to call more than once.
func (c *client) detach() {
	c.mu.Lock()
	was := c.attached
	c.attached = false
	c.mu.Unlock()
	if was {
		c.m.Detach(c.threadID, c)
	}
}

func (c *client) close() { c.once.Do(func() { _ = c.dc.Close() }) }

// serveChannel serves an agent:<threadId> channel until ctx ends.
func serveChannel(ctx context.Context, m *agent.Manager, dc *webrtc.DataChannel, threadID string) {
	c := &client{m: m, dc: dc, threadID: threadID}
	go func() {
		<-ctx.Done()
		c.detach()
	}()
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var cm protocol.AgentClientMsg
		if !msg.IsString || json.Unmarshal(msg.Data, &cm) != nil {
			return
		}
		c.mu.Lock()
		attached := c.attached
		if cm.T == "attach" && ctx.Err() == nil {
			c.attached = true
		}
		c.mu.Unlock()

		switch {
		case cm.T == "attach" && !attached:
			if ctx.Err() != nil {
				return
			}
			if err := m.Attach(threadID, c, cm.AfterSeq, cm.Limit); err != nil {
				c.mu.Lock()
				c.attached = false
				c.mu.Unlock()
				c.Send(protocol.AgentErrorMsg{T: "error", Message: err.Error()})
			}
		case cm.T == "attach":
			// Already attached; a second replay would duplicate events.
		case !attached:
			c.Send(protocol.AgentErrorMsg{T: "error", Message: "attach first"})
		default:
			m.Handle(threadID, c, cm)
		}
	})
}
