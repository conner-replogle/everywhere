// Package peer answers WebRTC connections from browsers and serves the control
// RPC and terminal data channels over them.
package peer

import (
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
	"github.com/conner-replogle/everywhere/daemon/internal/term"
)

// Signaler sends a signaling message to a browser connection via the hub.
type Signaler func(to, sid string, data protocol.SignalData)

type Server struct {
	// ICEServers supplies STUN/TURN servers for new connections.
	ICEServers func() []webrtc.ICEServer

	store *store.Store
	terms *term.Manager
	info  protocol.DeviceInfo
	api   *webrtc.API

	mu     sync.Mutex
	peers  map[string]*peer // by sid
	signal Signaler
}

type peer struct {
	sid     string
	from    string
	pc      *webrtc.PeerConnection
	started time.Time

	mu       sync.Mutex
	control  *webrtc.DataChannel
	answered bool
	pending  []protocol.SignalData // local candidates gathered before the answer was sent
	terms    map[*termClient]bool
}

// closeTerms detaches every terminal this peer had open. Data channel close
// callbacks aren't guaranteed when the whole connection drops.
func (p *peer) closeTerms() {
	p.mu.Lock()
	terms := p.terms
	p.terms = nil
	p.mu.Unlock()
	for c := range terms {
		c.detach()
	}
}

func NewServer(st *store.Store, info protocol.DeviceInfo) *Server {
	se := webrtc.SettingEngine{}
	// Skip container/VM bridges; they only slow ICE down. Tailscale's
	// interface is what actually connects.
	se.SetInterfaceFilter(func(name string) bool {
		for _, p := range []string{"docker", "br-", "veth", "virbr", "cni", "flannel", "podman"} {
			if strings.HasPrefix(name, p) {
				return false
			}
		}
		return true
	})
	se.SetICETimeouts(5*time.Second, 15*time.Second, 2*time.Second)
	s := &Server{
		store: st,
		info:  info,
		api:   webrtc.NewAPI(webrtc.WithSettingEngine(se)),
		peers: map[string]*peer{},
	}
	s.terms = term.NewManager(st, func() { s.broadcast(protocol.EventThreadsChanged) })
	return s
}

// SetSignaler sets how answers and candidates reach browsers.
func (s *Server) SetSignaler(fn Signaler) {
	s.mu.Lock()
	s.signal = fn
	s.mu.Unlock()
}

// Shutdown closes all peers and kills all shells.
func (s *Server) Shutdown() {
	s.mu.Lock()
	peers := make([]*peer, 0, len(s.peers))
	for _, p := range s.peers {
		peers = append(peers, p)
	}
	s.mu.Unlock()
	for _, p := range peers {
		_ = p.pc.Close()
	}
	s.terms.Shutdown()
}

// HandleSignal processes one signaling message from a browser. Messages for a
// given sid arrive in order on the hub socket, so this is called serially.
func (s *Server) HandleSignal(from, sid string, data protocol.SignalData) {
	switch data.Type {
	case "offer":
		if err := s.answer(from, sid, data.SDP); err != nil {
			slog.Warn("answer offer", "sid", sid, "err", err)
			s.send(from, sid, protocol.SignalData{Type: "bye"})
		}
	case "candidate":
		p := s.peer(sid)
		if p == nil || data.Candidate == nil {
			return
		}
		c := data.Candidate
		if err := p.pc.AddICECandidate(webrtc.ICECandidateInit{
			Candidate: c.Candidate, SDPMid: c.SDPMid, SDPMLineIndex: c.SDPMLineIndex, UsernameFragment: c.UsernameFragment,
		}); err != nil {
			slog.Debug("add candidate", "sid", sid, "err", err)
		}
	case "bye":
		if p := s.peer(sid); p != nil {
			_ = p.pc.Close()
		}
	}
}

func (s *Server) answer(from, sid, sdp string) error {
	if old := s.peer(sid); old != nil {
		_ = old.pc.Close()
	}
	servers := []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478"}}}
	if s.ICEServers != nil {
		servers = s.ICEServers()
	}
	pc, err := s.api.NewPeerConnection(webrtc.Configuration{ICEServers: servers})
	if err != nil {
		return err
	}
	p := &peer{sid: sid, from: from, pc: pc, started: time.Now(), terms: map[*termClient]bool{}}
	s.mu.Lock()
	s.peers[sid] = p
	s.mu.Unlock()

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		msg := protocol.SignalData{Type: "candidate", Candidate: &protocol.IceCandidate{
			Candidate: init.Candidate, SDPMid: init.SDPMid, SDPMLineIndex: init.SDPMLineIndex,
		}}
		// Browsers reject candidates that arrive before the answer.
		p.mu.Lock()
		if !p.answered {
			p.pending = append(p.pending, msg)
			p.mu.Unlock()
			return
		}
		p.mu.Unlock()
		s.send(from, sid, msg)
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		slog.Info("peer state", "sid", sid, "state", st.String())
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed {
			_ = pc.Close()
			p.closeTerms()
			s.mu.Lock()
			if s.peers[sid] == p {
				delete(s.peers, sid)
			}
			s.mu.Unlock()
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		switch label := dc.Label(); {
		case label == protocol.ControlChannel:
			s.serveControl(p, dc)
		case strings.HasPrefix(label, protocol.TermChannelPrefix):
			s.serveTerm(p, dc, strings.TrimPrefix(label, protocol.TermChannelPrefix))
		default:
			_ = dc.Close()
		}
	})

	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		return err
	}
	ans, err := pc.CreateAnswer(nil)
	if err != nil {
		return err
	}
	if err := pc.SetLocalDescription(ans); err != nil {
		return err
	}
	s.send(from, sid, protocol.SignalData{Type: "answer", SDP: ans.SDP})
	p.mu.Lock()
	p.answered = true
	pending := p.pending
	p.pending = nil
	p.mu.Unlock()
	for _, c := range pending {
		s.send(from, sid, c)
	}
	return nil
}

// CloseClient closes every peer opened by a browser connection whose session
// was signed out.
func (s *Server) CloseClient(connID string) {
	s.mu.Lock()
	var closing []*peer
	for _, p := range s.peers {
		if p.from == connID {
			closing = append(closing, p)
		}
	}
	s.mu.Unlock()
	for _, p := range closing {
		slog.Info("closing peer of signed-out session", "sid", p.sid)
		_ = p.pc.Close()
	}
}

func (s *Server) peer(sid string) *peer {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.peers[sid]
}

func (s *Server) send(to, sid string, data protocol.SignalData) {
	s.mu.Lock()
	fn := s.signal
	s.mu.Unlock()
	if fn != nil {
		fn(to, sid, data)
	}
}

// broadcast sends an RPC event to every connected control channel.
func (s *Server) broadcast(event string) {
	msg, _ := json.Marshal(protocol.RPCEvent{Event: event})
	s.mu.Lock()
	peers := make([]*peer, 0, len(s.peers))
	for _, p := range s.peers {
		peers = append(peers, p)
	}
	s.mu.Unlock()
	for _, p := range peers {
		p.mu.Lock()
		dc := p.control
		p.mu.Unlock()
		if dc != nil && dc.ReadyState() == webrtc.DataChannelStateOpen {
			_ = dc.SendText(string(msg))
		}
	}
}
