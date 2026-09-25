// Package desktop serves remote desktop sessions of the logged-in Hyprland
// session: each viewer gets its own PeerConnection (signaled over the device
// connection's control channel) carrying a low-latency video track plus input
// and control data channels. Capture, encoding and input injection run in an
// everywhere-desktop worker process (see ipc); this package stays CGO-free.
//
// It is omarchote's host, embedded in the daemon.
package desktop

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/cc"
	"github.com/pion/interceptor/pkg/gcc"
	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/wire"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

const extPlayoutDelay = "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay"

// ErrDisabled is returned when remote desktop hasn't been enabled on the device.
var ErrDisabled = errors.New("remote desktop is turned off on this device; run `everywhere desktop enable` on it")

// Manager runs at most one remote desktop session at a time; a new viewer
// takes over from the previous one.
type Manager struct {
	// ICEServers supplies STUN/TURN servers for new sessions.
	ICEServers func() []webrtc.ICEServer
	// Enabled reports whether the device owner turned remote desktop on.
	Enabled func() bool

	api        *webrtc.API
	estimators chan cc.BandwidthEstimator

	mu   sync.Mutex
	sess *session
}

// NewManager builds the media stack for desktop sessions. se is the daemon's
// setting engine (interface filtering and ICE timeouts).
func NewManager(se webrtc.SettingEngine) (*Manager, error) {
	m := &webrtc.MediaEngine{}
	fb := []webrtc.RTCPFeedback{
		{Type: "goog-remb"}, {Type: "ccm", Parameter: "fir"}, {Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: "transport-cc"},
	}
	videoCodecs := []struct {
		mime string
		fmtp string
	}{
		{webrtc.MimeTypeH264, "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=64001f"},
		{webrtc.MimeTypeH264, "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"},
	}
	for i, c := range videoCodecs {
		err := m.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: c.mime, ClockRate: 90000, SDPFmtpLine: c.fmtp, RTCPFeedback: fb},
			PayloadType:        webrtc.PayloadType(102 + i),
		}, webrtc.RTPCodecTypeVideo)
		if err != nil {
			return nil, err
		}
	}
	if err := m.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: extPlayoutDelay}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}

	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(m, ir); err != nil {
		return nil, err
	}
	// Send-side bandwidth estimation. No pacer: pacing large keyframes adds latency.
	estimators := make(chan cc.BandwidthEstimator, 1)
	congestion, err := cc.NewInterceptor(func() (cc.BandwidthEstimator, error) {
		return gcc.NewSendSideBWE(
			gcc.SendSideBWEInitialBitrate(20_000_000),
			gcc.SendSideBWEMinBitrate(300_000),
			gcc.SendSideBWEMaxBitrate(50_000_000),
			gcc.SendSideBWEPacer(gcc.NewNoOpPacer()),
		)
	})
	if err != nil {
		return nil, err
	}
	congestion.OnNewPeerConnection(func(_ string, est cc.BandwidthEstimator) {
		select {
		case estimators <- est:
		default:
		}
	})
	ir.Add(congestion)
	if err := webrtc.ConfigureTWCCHeaderExtensionSender(m, ir); err != nil {
		return nil, err
	}

	return &Manager{
		api:        webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(ir), webrtc.WithSettingEngine(se)),
		estimators: estimators,
	}, nil
}

func (m *Manager) enabled() bool { return m.Enabled == nil || m.Enabled() }

// Info reports whether remote desktop can be used right now.
func (m *Manager) Info() protocol.DesktopInfo {
	info := protocol.DesktopInfo{Enabled: m.enabled()}
	m.mu.Lock()
	if m.sess != nil {
		info.Viewer = m.sess.viewer.Name
	}
	m.mu.Unlock()
	switch _, err := helperPath(); {
	case err != nil:
		info.Reason = err.Error()
	default:
		if _, err := findHyprland(); err != nil {
			info.Reason = err.Error()
		} else {
			info.Available = true
		}
	}
	return info
}

// Start answers a viewer's offer with a new session, ending the current one.
// The session's ICE candidates follow through onCandidate, possibly before
// Start returns.
func (m *Manager) Start(offer string, mode wire.Mode, v Viewer, src protocol.DesktopSource, onCandidate func(id string, c webrtc.ICECandidateInit)) (protocol.DesktopStarted, error) {
	if !m.enabled() {
		return protocol.DesktopStarted{}, ErrDisabled
	}
	h, err := findHyprland()
	if err != nil {
		return protocol.DesktopStarted{}, err
	}
	var servers []webrtc.ICEServer
	if m.ICEServers != nil {
		servers = m.ICEServers()
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sess != nil {
		m.sess.endWith(wire.SessionEnded{Reason: wire.EndTakenOver, Detail: v.Name})
		m.sess = nil
	}
	id := newID()
	want := source{Output: src.Output, Window: src.Window, Class: src.Class, Title: src.Title}
	sess, answer, err := startSession(m, id, offer, mode, v, want, h, servers, func(c webrtc.ICECandidateInit) {
		if onCandidate != nil {
			onCandidate(id, c)
		}
	})
	if err != nil {
		return protocol.DesktopStarted{}, err
	}
	m.sess = sess
	return protocol.DesktopStarted{ID: id, SDP: answer}, nil
}

// AddCandidate applies a viewer's trickled ICE candidate to its session.
func (m *Manager) AddCandidate(id string, c webrtc.ICECandidateInit) {
	m.mu.Lock()
	s := m.sess
	m.mu.Unlock()
	if s != nil && s.id == id {
		s.addCandidate(c)
	}
}

// Stop ends the session with this id (the viewer left).
func (m *Manager) Stop(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sess == nil || m.sess.id != id {
		return
	}
	m.sess.close("viewer left")
	m.sess = nil
}

// CloseClient ends the session a signed-out browser connection opened.
func (m *Manager) CloseClient(connID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sess == nil || m.sess.viewer.Client != connID {
		return
	}
	m.sess.close("signed out")
	m.sess = nil
}

// CloseTab ends the session a desktop tab showed; the tab was closed.
func (m *Manager) CloseTab(tabID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sess == nil || tabID == "" || m.sess.viewer.Tab != tabID {
		return
	}
	m.sess.close("tab closed")
	m.sess = nil
}

// sessionEnded is called by a session that died on its own (ICE failure,
// capture error).
func (m *Manager) sessionEnded(s *session) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sess == s {
		m.sess = nil
	}
}

// Shutdown ends the session, telling the viewer why.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sess != nil {
		m.sess.endWith(wire.SessionEnded{Reason: wire.EndHostShutdown})
		m.sess = nil
	}
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
