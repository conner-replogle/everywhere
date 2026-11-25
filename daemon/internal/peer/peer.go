// Package peer answers WebRTC connections from browsers and is the daemon's
// core: the control channel and the core's own methods (device, projects,
// threads, tabs), with everything else served by plugins through the
// plugin registry (internal/plugin).
package peer

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/ice"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
	"github.com/conner-replogle/everywhere/daemon/internal/version"
)

// Signaler sends a signaling message to a browser connection via the hub.
type Signaler func(to, sid string, data protocol.SignalData)

type Server struct {
	// ICEServers supplies STUN/TURN servers for new connections.
	ICEServers func() []webrtc.ICEServer
	// Restart, if set, restarts the daemon into a newly installed binary;
	// device.update needs it.
	Restart func()
	// DesktopEnabled reports whether the device owner turned remote desktop on.
	DesktopEnabled func() bool
	// PluginEnabled reports whether the device owner enabled an external plugin.
	PluginEnabled func(id string) bool
	// AgentsEnabled reports whether this device lets connected agents in;
	// SetAgents changes it (from a browser over WebRTC only).
	AgentsEnabled func() bool
	SetAgents     func(on bool) error
	// AutoUpdate reports whether the daemon updates itself when idle;
	// SetAutoUpdate changes it.
	AutoUpdate    func() bool
	SetAutoUpdate func(on bool) error

	store   *store.Store
	plugins *plugin.Registry
	info    protocol.DeviceInfo
	dataDir string
	se      webrtc.SettingEngine
	api     *webrtc.API

	mu     sync.Mutex
	peers  map[string]*peer // by sid
	signal Signaler
	notify func(protocol.HubNotify)

	updating atomic.Bool
	updateMu sync.Mutex
	latest   string // latest release version, cached
	latestAt time.Time
}

type peer struct {
	s       *Server
	sid     string
	pc      *webrtc.PeerConnection
	started time.Time
	// ctx ends when the connection closes, and with it every channel's.
	ctx    context.Context
	cancel context.CancelFunc

	mu sync.Mutex
	// from is the browser's hub connection; an ICE restart can come from a
	// new one (iOS drops the socket of an app in the background).
	from     string
	control  *webrtc.DataChannel
	answered bool
	pending  []protocol.SignalData // local candidates gathered before the answer was sent
	open     map[string]int        // open channels by label prefix, for debug.peer
}

func (p *peer) ID() string { return p.sid }
func (p *peer) Client() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.from
}

// Send sends an event on the peer's control channel.
func (p *peer) Send(event any) {
	msg, err := json.Marshal(event)
	if err != nil {
		return
	}
	p.mu.Lock()
	dc := p.control
	p.mu.Unlock()
	if dc != nil && dc.ReadyState() == webrtc.DataChannelStateOpen {
		sendControl(dc, msg)
	}
}

// closeChannels ends every channel and session this peer had open. Data
// channel close callbacks aren't guaranteed when the whole connection
// drops, so channels wait on the peer's context too.
func (p *peer) closeChannels() {
	p.cancel()
	p.s.plugins.PeerClosed(p)
}

// keepTimeout is how long a browser's connection is kept after the daemon
// last heard from it, for an ICE restart to bring back (after the 5 s it takes
// to call it disconnected). The web app's DAEMON_KEEP_MS is a little less.
const keepTimeout = 2 * time.Minute

// NewServer serves the store's projects and threads, and hosts plugins;
// they keep their files under dataDir.
func NewServer(st *store.Store, info protocol.DeviceInfo, dataDir string, plugins ...plugin.Plugin) *Server {
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
	// Plugins' connections (remote desktop video) give up on a silent peer
	// soon, so nothing keeps encoding for a viewer that's gone.
	se.SetICETimeouts(5*time.Second, 15*time.Second, 2*time.Second)
	// Browsers' own connections are kept for a while instead: a phone that
	// was in the background or changed networks comes back with an ICE
	// restart, and its terminals and threads carry on where they were.
	core := se
	core.SetICETimeouts(5*time.Second, keepTimeout, 2*time.Second)
	// After a restart, data sent into the silence goes again within this,
	// rather than after the default backoff of up to a minute.
	core.SetSCTPRTOMax(2 * time.Second)
	s := &Server{
		store:   st,
		info:    info,
		dataDir: dataDir,
		se:      se,
		api:     webrtc.NewAPI(webrtc.WithSettingEngine(core)),
		peers:   map[string]*peer{},
	}
	s.plugins = plugin.NewRegistry(plugin.ToolServerName, version.Version, plugins...)
	s.registerCore(s.plugins.Core(s))
	s.plugins.Start(s)
	return s
}

// Plugins is the plugin registry.
func (s *Server) Plugins() *plugin.Registry { return s.plugins }

// SetNotifier sets where notifications go (the hub).
func (s *Server) SetNotifier(fn func(protocol.HubNotify)) {
	s.mu.Lock()
	s.notify = fn
	s.mu.Unlock()
}

// SetSignaler sets how answers and candidates reach browsers.
func (s *Server) SetSignaler(fn Signaler) {
	s.mu.Lock()
	s.signal = fn
	s.mu.Unlock()
}

// Shutdown closes all peers and stops every plugin.
func (s *Server) Shutdown() {
	s.mu.Lock()
	peers := make([]*peer, 0, len(s.peers))
	for _, p := range s.peers {
		peers = append(peers, p)
	}
	s.mu.Unlock()
	// pion's Close waits several seconds on a live connection; the process
	// is exiting (or re-execing), so don't hold it up for long.
	closed := make(chan struct{})
	go func() {
		var wg sync.WaitGroup
		for _, p := range peers {
			wg.Go(func() { _ = p.pc.Close() })
		}
		wg.Wait()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(time.Second):
		slog.Info("not waiting for peer connections to finish closing")
	}
	s.plugins.Stop()
}

// HandleSignal processes one signaling message from a browser. Messages for a
// given sid arrive in order on the hub socket, so this is called serially.
func (s *Server) HandleSignal(from, sid string, data protocol.SignalData) {
	switch data.Type {
	case "offer":
		answer := s.answer
		if data.Restart {
			answer = s.restart
		}
		if err := answer(from, sid, data.SDP); err != nil {
			slog.Warn("answer offer", "sid", sid, "restart", data.Restart, "err", err)
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
	pc, err := s.api.NewPeerConnection(webrtc.Configuration{ICEServers: s.iceServers()})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &peer{s: s, sid: sid, from: from, pc: pc, started: time.Now(), ctx: ctx, cancel: cancel, open: map[string]int{}}
	s.mu.Lock()
	s.peers[sid] = p
	s.mu.Unlock()

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := ice.Candidate(c)
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
		to := p.from
		p.mu.Unlock()
		s.send(to, sid, msg)
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		slog.Info("peer state", "sid", sid, "state", st.String())
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed {
			_ = pc.Close()
			p.closeChannels()
			s.mu.Lock()
			if s.peers[sid] == p {
				delete(s.peers, sid)
			}
			s.mu.Unlock()
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		label := dc.Label()
		if label == protocol.ControlChannel {
			s.serveControl(p, dc)
			return
		}
		fn, rest, ok := s.plugins.Channel(label)
		if !ok || p.ctx.Err() != nil {
			_ = dc.Close()
			return
		}
		prefix := strings.TrimSuffix(label, rest)
		ctx, cancel := context.WithCancel(p.ctx)
		p.mu.Lock()
		p.open[prefix]++
		p.mu.Unlock()
		var once sync.Once
		dc.OnClose(func() {
			once.Do(func() {
				p.mu.Lock()
				p.open[prefix]--
				p.mu.Unlock()
			})
			cancel()
		})
		fn(ctx, plugin.ChannelContext{Peer: p, Label: label, Rest: rest}, dc)
	})

	return s.reply(p, sdp)
}

// restart answers an ICE restart: the browser changed networks or was frozen
// in the background, and wants a new route for a connection this daemon
// still has. Its channels, and the sessions on them, carry on. One the
// daemon has already dropped can't come back; the error sends bye, and the
// browser makes a new connection.
func (s *Server) restart(from, sid, sdp string) error {
	p := s.peer(sid)
	if p == nil {
		return errors.New("no connection to restart")
	}
	p.mu.Lock()
	p.from = from
	p.answered = false
	p.mu.Unlock()
	slog.Info("peer ICE restart", "sid", sid)
	return s.reply(p, sdp)
}

// reply answers p's offer, then sends the candidates gathered meanwhile.
func (s *Server) reply(p *peer, sdp string) error {
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		return err
	}
	ans, err := p.pc.CreateAnswer(nil)
	if err != nil {
		return err
	}
	if err := p.pc.SetLocalDescription(ans); err != nil {
		return err
	}
	p.mu.Lock()
	to := p.from
	p.mu.Unlock()
	s.send(to, p.sid, protocol.SignalData{Type: "answer", SDP: ans.SDP})
	p.mu.Lock()
	p.answered = true
	pending := p.pending
	p.pending = nil
	p.mu.Unlock()
	for _, c := range pending {
		s.send(to, p.sid, c)
	}
	return nil
}

func (s *Server) iceServers() []webrtc.ICEServer {
	if s.ICEServers != nil {
		return s.ICEServers()
	}
	return []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478"}}}
}

// CloseClient closes every peer opened by a browser connection whose session
// was signed out.
func (s *Server) CloseClient(connID string) {
	s.mu.Lock()
	var closing []*peer
	for _, p := range s.peers {
		if p.Client() == connID {
			closing = append(closing, p)
		}
	}
	s.mu.Unlock()
	for _, p := range closing {
		slog.Info("closing peer of signed-out session", "sid", p.sid)
		_ = p.pc.Close()
	}
	plugin.Publish(s.plugins.Bus(), plugin.ClientRevoked, connID)
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
func (s *Server) broadcast(event string) { s.Broadcast(protocol.RPCEvent{Event: event}) }

// Broadcast sends an event with a payload to every connected control
// channel.
func (s *Server) Broadcast(event any) {
	msg, _ := json.Marshal(event)
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
			sendControl(dc, msg)
		}
	}
}

// The plugin.Core the registry hosts plugins with.

func (s *Server) Store() *store.Store { return s.store }
func (s *Server) DataDir() string     { return s.dataDir }
func (s *Server) WebRTC() plugin.WebRTC {
	return webRTC{s}
}
func (s *Server) Config() plugin.Config { return config{s} }

// Info is the device's info, with its plugins.
func (s *Server) Info() protocol.DeviceInfo {
	info := s.info
	info.Features = append(append([]string{}, s.info.Features...), protocol.FeaturePlugins)
	for _, f := range s.plugins.Features() {
		info.Features = append(info.Features, f)
	}
	for _, m := range s.plugins.Manifests() {
		info.Plugins = append(info.Plugins, m.Info())
	}
	return info
}

func (s *Server) Threads() plugin.Threads {
	return plugin.StoreThreads{
		Store:    s.store,
		OnChange: func() { s.broadcast(protocol.EventThreadsChanged) },
		Decorate: s.plugins.Decorate,
	}
}

// Notify sends a notification through the hub.
func (s *Server) Notify(n protocol.HubNotify) {
	s.mu.Lock()
	fn := s.notify
	s.mu.Unlock()
	if fn != nil {
		fn(n)
	}
}

type webRTC struct{ s *Server }

func (w webRTC) SettingEngine() webrtc.SettingEngine { return w.s.se }
func (w webRTC) ICEServers() []webrtc.ICEServer      { return w.s.iceServers() }

type config struct{ s *Server }

func (c config) DesktopEnabled() bool { return c.s.DesktopEnabled != nil && c.s.DesktopEnabled() }
func (c config) PluginEnabled(id string) bool {
	return c.s.PluginEnabled != nil && c.s.PluginEnabled(id)
}
