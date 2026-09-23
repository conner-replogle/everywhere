package peer

import (
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// agentClient adapts an agent:<threadId> data channel to agent.Client.
type agentClient struct {
	s        *Server
	dc       *webrtc.DataChannel
	once     sync.Once
	threadID string

	mu       sync.Mutex
	attached bool
}

func (c *agentClient) Send(frame any) {
	if c.dc.BufferedAmount() > maxBuffered {
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
func (c *agentClient) detach() {
	c.mu.Lock()
	was := c.attached
	c.attached = false
	c.mu.Unlock()
	if was {
		c.s.agents.Detach(c.threadID, c)
	}
}

func (c *agentClient) close() { c.once.Do(func() { _ = c.dc.Close() }) }

func (s *Server) serveAgent(p *peer, dc *webrtc.DataChannel, threadID string) {
	c := &agentClient{s: s, dc: dc, threadID: threadID}
	p.mu.Lock()
	if p.agents == nil { // peer already closed
		p.mu.Unlock()
		_ = dc.Close()
		return
	}
	p.agents[c] = true
	p.mu.Unlock()

	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var m protocol.AgentClientMsg
		if !msg.IsString || json.Unmarshal(msg.Data, &m) != nil {
			return
		}
		c.mu.Lock()
		attached := c.attached
		if m.T == "attach" {
			c.attached = true
		}
		c.mu.Unlock()

		switch {
		case m.T == "attach" && !attached:
			if err := s.agents.Attach(threadID, c, m.AfterSeq); err != nil {
				c.mu.Lock()
				c.attached = false
				c.mu.Unlock()
				c.Send(protocol.AgentErrorMsg{T: "error", Message: err.Error()})
			}
		case m.T == "attach":
			// Already attached; a second replay would duplicate events.
		case !attached:
			c.Send(protocol.AgentErrorMsg{T: "error", Message: "attach first"})
		default:
			s.agents.Handle(threadID, c, m)
		}
	})
	dc.OnClose(func() {
		c.detach()
		p.mu.Lock()
		delete(p.agents, c)
		p.mu.Unlock()
	})
}
