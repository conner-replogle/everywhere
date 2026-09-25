package desktop

import (
	"errors"
	"log/slog"
	"math"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/pion/interceptor/pkg/cc"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
	"github.com/conner-replogle/everywhere/daemon/internal/desktop/wire"
)

const rtpMTU = 1200

var codecMimes = map[ipc.Codec]string{
	ipc.H264: webrtc.MimeTypeH264,
	ipc.H265: webrtc.MimeTypeH265,
	ipc.AV1:  webrtc.MimeTypeAV1,
}

// Viewer is who opened a session.
type Viewer struct {
	Name   string // e.g. "Chrome on macOS"
	Client string // hub connection id, so signing out ends the session
	Tab    string // the desktop tab showing it, if any, so closing the tab ends it
}

// session is one viewer's remote desktop connection: its own PeerConnection
// with a video track and the input/control data channels.
type session struct {
	m      *Manager
	id     string
	viewer Viewer
	pc     *webrtc.PeerConnection
	ctl    *controller
	est    cc.BandwidthEstimator // nil if the congestion controller didn't attach
	hypr   *hyprInstance

	sender *webrtc.RTPSender
	// One track per negotiated codec; the sender switches between them with ReplaceTrack.
	tracks         map[ipc.Codec]*webrtc.TrackLocalStaticRTP
	playoutDelayID uint8
	seq            rtp.Sequencer

	mu         sync.Mutex // guards everything below
	mode       wire.Mode
	boundCodec ipc.Codec
	media      *media
	control    *webrtc.DataChannel
	follow     bool   // switch the capture to whichever monitor Hyprland focuses
	wm         []byte // the last Workspaces message
	windows    []byte // the last Windows message
	activeWin  string // the focused window's address
	clipSync   bool   // exchange clipboard text with the viewer
	clipLast   string // the clipboard text both sides have
	closed     bool
	done       chan struct{}
	connected  bool
	uninhibit  func()

	closeOnce sync.Once
}

// media is one capture of one monitor or window with one encoder configuration.
type media struct {
	cap           *worker
	src           source      // what was asked for, to restart it
	output        string      // the monitor: captured, or the window's
	win           *windowGeom // the captured window; nil for a monitor
	codec         ipc.Codec
	scale         float64
	width, height int // encoded size
	nativeW       int
	nativeH       int
	kbps          int
	kbpsChanged   time.Time
	pumpDone      chan struct{}
	cursorDone    chan struct{}
}

// startSession answers offer at once; the daemon's ICE candidates follow
// through onCandidate as they are gathered (trickle ICE).
func startSession(m *Manager, id, offer string, mode wire.Mode, v Viewer, src source, h *hyprInstance, servers []webrtc.ICEServer, onCandidate func(webrtc.ICECandidateInit)) (*session, string, error) {
	pc, err := m.api.NewPeerConnection(webrtc.Configuration{ICEServers: servers})
	if err != nil {
		return nil, "", err
	}
	s := &session{
		m: m, id: id, viewer: v, pc: pc, mode: mode, hypr: h, seq: rtp.NewRandomSequencer(), follow: true,
		tracks: map[ipc.Codec]*webrtc.TrackLocalStaticRTP{}, done: make(chan struct{}),
	}
	select {
	case s.est = <-m.estimators:
	case <-time.After(time.Second):
		slog.Warn("no bandwidth estimator; bitrate will not adapt", "session", id)
	}
	fail := func(err error) (*session, string, error) {
		_ = pc.Close()
		return nil, "", err
	}

	h264, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000}, "video", "everywhere")
	if err != nil {
		return fail(err)
	}
	transceiver, err := pc.AddTransceiverFromTrack(h264, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		return fail(err)
	}
	s.sender = transceiver.Sender()
	s.boundCodec = ipc.H264
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil && onCandidate != nil {
			onCandidate(c.ToJSON())
		}
	})
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer}); err != nil {
		return fail(err)
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return fail(err)
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		return fail(err)
	}

	params := s.sender.GetParameters()
	for _, ext := range params.HeaderExtensions {
		if ext.URI == extPlayoutDelay {
			s.playoutDelayID = uint8(ext.ID)
		}
	}
	for codec, mime := range codecMimes {
		for _, c := range params.Codecs {
			if !strings.EqualFold(c.MimeType, mime) {
				continue
			}
			if codec == ipc.H264 {
				s.tracks[codec] = h264
			} else if t, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: mime, ClockRate: 90000}, "video", "everywhere"); err == nil {
				s.tracks[codec] = t
			}
			break
		}
	}
	if s.tracks[ipc.H264] == nil {
		return fail(errors.New("this browser doesn't support H.264 (packetization-mode=1)"))
	}

	s.ctl = &controller{sess: s}
	if src.Window != "" || src.Class != "" {
		// A tab's window may have been reopened since: find it again.
		if clients, err := h.clients(); err == nil {
			if c := resolveWindow(clients, src); c != nil {
				src = source{Window: c.StableID}
			} else {
				src = source{}
			}
		}
	}
	if src.Window == "" && src.Output == "" {
		// Start where the host's focus is, so typing lands on what the viewer sees.
		if mons, err := h.monitors(); err == nil {
			src.Output = focusedOutput(mons)
		}
	}
	if err := s.startMedia(src); err != nil {
		return fail(err)
	}
	pc.OnDataChannel(s.ctl.attach)
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		slog.Info("desktop peer connection", "session", id, "state", st.String())
		switch st {
		case webrtc.PeerConnectionStateConnected:
			s.requestKeyframe()
			s.onConnected()
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			go s.end(st.String())
		}
	})
	go s.readRTCP()
	go s.watchPath()
	go s.watchWM()
	go s.watchClipboard()
	if s.est != nil {
		go s.adaptBitrate()
	}
	return s, answer.SDP, nil
}

// addCandidate applies one of the viewer's trickled ICE candidates.
func (s *session) addCandidate(c webrtc.ICECandidateInit) {
	if err := s.pc.AddICECandidate(c); err != nil {
		slog.Debug("add desktop candidate", "session", s.id, "err", err)
	}
}

// startMedia captures src with the current mode's profile. Must hold s.mu (or
// be constructing).
func (s *session) startMedia(src source) error {
	prof := profileFor(s.mode, s.m.AV1)

	codec := ipc.H264
	for _, c := range prof.codecs {
		if s.tracks[c] != nil {
			codec = c
			break
		}
	}
	md := &media{codec: codec, scale: 1, pumpDone: make(chan struct{}), cursorDone: make(chan struct{})}
	mons, err := s.hypr.monitors()
	if err != nil {
		return err
	}
	var mon hyprMonitor
	nativeW, nativeH := 0, 0
	if src.Window != "" {
		clients, err := s.hypr.clients()
		if err != nil {
			return err
		}
		c := resolveWindow(clients, source{Window: src.Window})
		if c == nil {
			return errWindowGone
		}
		var ok bool
		if mon, ok = monitorByID(mons, c.Monitor); !ok {
			return errors.New("the window isn't on a monitor")
		}
		md.win = newWindowGeom(c, mon)
		nativeW, nativeH = int(math.Round(float64(c.Size[0])*mon.Scale)), int(math.Round(float64(c.Size[1])*mon.Scale))
		md.src = source{Window: src.Window}
	} else {
		var ok bool
		if mon, ok = resolveOutput(src.Output, mons); !ok {
			return errors.New("no monitor named " + src.Output)
		}
		nativeW, nativeH = mon.Width, mon.Height
		md.src = source{Output: mon.Name}
	}
	md.output, md.scale = mon.Name, mon.Scale
	encW, encH := scaledSize(nativeW, nativeH, prof.maxHeight)

	md.kbps = prof.startKbps
	if s.est != nil {
		md.kbps = min(md.kbps, s.est.GetTargetBitrate()/1000)
	}
	md.kbps = clamp(md.kbps, prof.minKbps, prof.maxKbps)
	md.kbpsChanged = time.Now()

	c, err := startWorker(ipc.Config{
		Output: md.output, Window: src.Window, BitrateKbps: md.kbps, TargetUsage: prof.targetUsage,
		Codec: codec, Width: encW, Height: encH, MaxFPS: prof.maxFPS,
		Input: true, Keymap: s.hypr.keymap(),
	}, s.hypr.env())
	if err != nil {
		return err
	}
	md.cap = c
	md.width, md.height = c.Size()
	md.nativeW, md.nativeH = md.width, md.height
	if encW > 0 {
		md.width, md.height = encW, encH
	}
	if msg := c.InputError(); msg != "" {
		slog.Warn("desktop input unavailable; session is view-only", "session", s.id, "err", msg)
	}

	if codec != s.boundCodec {
		if err := s.sender.ReplaceTrack(s.tracks[codec]); err != nil {
			c.Close()
			c.Free()
			return err
		}
		s.boundCodec = codec
	}
	slog.Info("desktop capture started", "session", s.id, "output", md.output, "window", src.Window, "codec", codec, "size", [2]int{md.width, md.height}, "kbps", md.kbps, "mode", s.mode)

	s.media = md
	go s.pump(md)
	go s.cursorLoop(md)
	if s.ctl != nil {
		go s.ctl.replayHeld() // after s.mu is released; the controller locks in the other order
	}
	return nil
}

func (s *session) stopMedia() {
	md := s.media
	if md == nil {
		return
	}
	s.media = nil
	md.cap.Close()
	<-md.pumpDone
	<-md.cursorDone
	md.cap.Free()
}

// restartLocked replaces the capture, falling back to fallback if src fails.
func (s *session) restartLocked(src, fallback source) {
	s.stopMedia()
	if err := s.startMedia(src); err != nil {
		slog.Error("desktop capture restart failed", "session", s.id, "source", src, "err", err)
		if err := s.startMedia(fallback); err != nil {
			slog.Error("restoring previous desktop capture failed", "session", s.id, "err", err)
			go s.end("capture failed")
			return
		}
	}
	s.sendHostInfoLocked()
}

func (s *session) switchOutput(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.media == nil || (s.media.win == nil && s.media.output == name) {
		return
	}
	s.restartLocked(source{Output: name}, s.media.src)
}

// selectWindow captures one window.
func (s *session) selectWindow(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.media == nil || id == "" || s.media.src.Window == id {
		return
	}
	s.restartLocked(source{Window: id}, s.media.src)
}

func (s *session) setMode(mode wire.Mode) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.media == nil || s.mode == mode || mode > wire.ModeLowBandwidth {
		return
	}
	s.mode = mode
	s.restartLocked(s.media.src, s.media.src)
}

// recoverMedia restarts a capture that died: at the new size when the
// monitor or window was resized, on the window's monitor when the window
// closed, or after a GPU encoder reset aborted the worker (the VCN ring takes
// about 1.5 s to come back).
func (s *session) recoverMedia(failed *media, cause error) {
	s.mu.Lock()
	if s.closed || s.media != failed {
		s.mu.Unlock()
		return
	}
	s.stopMedia()
	s.mu.Unlock()

	src := failed.src
	resized := strings.HasPrefix(cause.Error(), "capture size changed")
	if cause.Error() == errWindowGone.Error() {
		src = source{Output: failed.output}
	}
	delay := 250 * time.Millisecond
	for attempt := 1; attempt <= 6; attempt++ {
		if attempt > 1 || !resized && src == failed.src {
			time.Sleep(delay)
			delay *= 2
		}
		s.mu.Lock()
		if s.closed || s.media != nil {
			s.mu.Unlock()
			return
		}
		err := s.startMedia(src)
		if errors.Is(err, errWindowGone) {
			src = source{Output: failed.output}
		}
		if err == nil {
			slog.Info("desktop capture recovered", "session", s.id, "attempt", attempt)
			s.sendHostInfoLocked()
		}
		s.mu.Unlock()
		if err == nil {
			return
		}
		slog.Warn("desktop capture restart failed", "session", s.id, "attempt", attempt, "err", err)
	}
	s.endWith(wire.SessionEnded{Reason: wire.EndCaptureError, Detail: "capture could not be restarted"})
	s.m.sessionEnded(s)
}

// adaptBitrate follows the send-side bandwidth estimate within the mode's
// range. Encoder reconfiguration isn't free, so small changes are ignored and
// increases are slow.
func (s *session) adaptBitrate() {
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-tick.C:
		}
		s.mu.Lock()
		md := s.media
		if md == nil {
			s.mu.Unlock()
			continue
		}
		prof := profileFor(s.mode, s.m.AV1)
		// Leave headroom for RTP overhead, retransmissions and keyframe bursts.
		target := clamp(s.est.GetTargetBitrate()*85/100/1000, prof.minKbps, prof.maxKbps)
		since := time.Since(md.kbpsChanged)
		down := target < md.kbps*80/100 && since > time.Second
		up := target > md.kbps*125/100 && since > 4*time.Second
		if down || up {
			slog.Debug("desktop bitrate", "session", s.id, "from", md.kbps, "to", target)
			md.kbps = target
			md.kbpsChanged = time.Now()
			md.cap.SetBitrate(target)
			if s.control != nil {
				_ = s.control.Send(s.modeInfoLocked().Marshal())
			}
		}
		s.mu.Unlock()
	}
}

func (s *session) requestKeyframe() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.media != nil {
		s.media.cap.RequestKeyframe()
	}
}

// input returns the capture that injects input, or nil between captures,
// and the captured window's geometry (nil for a monitor).
func (s *session) input() (*worker, *windowGeom) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.media == nil || s.media.cap.InputError() != "" {
		return nil, nil
	}
	return s.media.cap, s.media.win
}

func (s *session) setControl(dc *webrtc.DataChannel) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.control = dc
	s.sendHostInfoLocked()
	for _, msg := range [][]byte{s.wm, s.windows} {
		if msg != nil {
			_ = dc.Send(msg)
		}
	}
}

func (s *session) sendControl(b []byte) {
	s.mu.Lock()
	dc := s.control
	s.mu.Unlock()
	if dc != nil {
		_ = dc.Send(b)
	}
}

func (s *session) modeInfoLocked() wire.ModeInfo {
	info := wire.ModeInfo{Mode: s.mode}
	if md := s.media; md != nil {
		info.Codec = uint8(md.codec)
		info.Width, info.Height = uint16(md.width), uint16(md.height)
		info.BitrateKbps = uint32(md.kbps)
	}
	return info
}

func (s *session) sendHostInfoLocked() {
	if s.control == nil || s.media == nil {
		return
	}
	md := s.media
	hello := wire.Hello{Width: uint16(md.width), Height: uint16(md.height), Output: md.output}
	if md.win != nil {
		hello.Window, hello.Class, hello.Title = md.src.Window, md.win.Class, md.win.Title
	}
	_ = s.control.Send(hello.Marshal())
	_ = s.control.Send(s.modeInfoLocked().Marshal())
	mons, err := s.hypr.monitors()
	if err != nil {
		slog.Warn("listing monitors", "err", err)
		return
	}
	var outs []wire.OutputInfo
	for _, mon := range mons {
		if !mon.Disabled {
			outs = append(outs, wire.OutputInfo{Name: mon.Name, Width: uint16(mon.Width), Height: uint16(mon.Height), Active: mon.Name == md.output})
		}
	}
	_ = s.control.Send(wire.MarshalOutputs(outs))
}

func (s *session) readRTCP() {
	var lastKey time.Time
	for {
		pkts, _, err := s.sender.ReadRTCP()
		if err != nil {
			return
		}
		for _, p := range pkts {
			switch p.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				if time.Since(lastKey) > 250*time.Millisecond {
					lastKey = time.Now()
					s.requestKeyframe()
				}
			}
		}
	}
}

type payloader interface {
	Payload(mtu uint16, payload []byte) [][]byte
}

func (s *session) pump(md *media) {
	defer close(md.pumpDone)
	var pl payloader
	switch md.codec {
	case ipc.H265:
		pl = &codecs.H265Payloader{}
	case ipc.AV1:
		pl = &codecs.AV1Payloader{}
	default:
		pl = &codecs.H264Payloader{}
	}
	track := s.tracks[md.codec]
	// Chrome treats min=max=0 as "render immediately", bypassing its smoothing buffer.
	playoutDelay := []byte{0, 0, 0}

	for {
		f, err := md.cap.Next(50 * time.Millisecond)
		if err != nil {
			if !errors.Is(err, errClosed) {
				slog.Warn("desktop capture stopped", "session", s.id, "err", err)
				go s.recoverMedia(md, err)
			}
			return
		}
		if f == nil {
			continue
		}
		ts := uint32(f.CapturedAt.Microseconds() * 90 / 1000)
		payloads := pl.Payload(rtpMTU, f.Data)
		for i, payload := range payloads {
			pkt := &rtp.Packet{
				Header: rtp.Header{
					Version:        2,
					Marker:         i == len(payloads)-1,
					SequenceNumber: s.seq.NextSequenceNumber(),
					Timestamp:      ts,
				},
				Payload: payload,
			}
			if s.playoutDelayID != 0 {
				_ = pkt.Header.SetExtension(s.playoutDelayID, playoutDelay)
			}
			if err := track.WriteRTP(pkt); err != nil {
				slog.Debug("write rtp", "err", err)
			}
		}
	}
}

// cursorLoop forwards the host cursor image and position to the viewer.
func (s *session) cursorLoop(md *media) {
	defer close(md.cursorDone)
	var prev *cursor
	// Hyprland reports cursor positions in logical (scaled) output coordinates.
	scale := md.scale
	if scale <= 0 {
		scale = 1
	}
	logicalW, logicalH := float64(md.nativeW)/scale, float64(md.nativeH)/scale
	var lastPos wire.CursorPosition
	sentImage := false
	for {
		cur, err := md.cap.WaitCursor(prev, time.Second)
		if err != nil {
			return
		}
		if cur == nil {
			continue
		}
		if cur.RGBA != nil {
			img := wire.CursorImage{}
			if cursorImageUsable(cur.RGBA) && cur.Width <= 128 && cur.Height <= 128 {
				img = wire.CursorImage{Width: uint16(cur.Width), Height: uint16(cur.Height), HotX: uint16(cur.HotX), HotY: uint16(cur.HotY), RGBA: cur.RGBA}
			}
			if img.Width != 0 || sentImage {
				s.sendControl(img.Marshal())
				sentImage = img.Width != 0
			}
		}
		pos := wire.CursorPosition{Inside: cur.Inside, X: norm(float64(cur.X), logicalW), Y: norm(float64(cur.Y), logicalH)}
		if pos != lastPos {
			s.sendControl(pos.Marshal())
			lastPos = pos
		}
		prev = cur
	}
}

// cursorImageUsable is whether a captured cursor bitmap can be shown. Hyprland
// captures cursors apps set by shape (most toolkits) as fully transparent, and
// a fully opaque one is a square, not a cursor; the viewer shows its own
// arrow for both.
func cursorImageUsable(rgba []byte) bool {
	visible, clear := false, false
	for i := 3; i < len(rgba); i += 4 {
		if rgba[i] != 0 {
			visible = true
		}
		if rgba[i] != 255 {
			clear = true
		}
	}
	return visible && clear
}

func norm(v, extent float64) uint16 {
	if extent <= 0 {
		return 0
	}
	f := v / extent * 65535
	switch {
	case f < 0:
		return 0
	case f > 65535:
		return 65535
	}
	return uint16(f + 0.5)
}

// watchPath tells the viewer when its traffic is relayed: through Cloudflare
// TURN, or through a Tailscale DERP server when the path runs over the tailnet.
func (s *session) watchPath() {
	var last *wire.PeerInfo
	tick := time.NewTicker(3 * time.Second)
	defer tick.Stop()
	for {
		info := wire.PeerInfo{Device: s.viewer.Name}
		if pair, err := s.pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair(); err == nil && pair != nil {
			if pair.Local.Typ == webrtc.ICECandidateTypeRelay || pair.Remote.Typ == webrtc.ICECandidateTypeRelay {
				info.Relayed, info.Relay = true, "TURN"
			} else if ip, err := netip.ParseAddr(pair.Remote.Address); err == nil && isTailscale(ip) {
				if known, relayed, region := tailnetPath(ip.Unmap()); known && relayed {
					info.Relayed, info.Relay = true, "DERP "+region
				}
			}
		}
		s.mu.Lock()
		ready := s.control != nil
		s.mu.Unlock()
		if ready && (last == nil || *last != info) {
			if last == nil || last.Relayed != info.Relayed {
				slog.Info("desktop viewer path", "session", s.id, "viewer", info.Device, "relayed", info.Relayed, "relay", info.Relay)
			}
			s.sendControl(info.Marshal())
			last = &info
		}
		select {
		case <-s.done:
			return
		case <-tick.C:
		}
	}
}

func (s *session) onConnected() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.connected || s.closed {
		return
	}
	s.connected = true
	s.uninhibit = inhibitSleep("Remote desktop session from " + s.viewer.Name)
	notify(s.hypr, "Remote desktop started", s.viewer.Name+" is viewing and controlling this computer")
}

// endWith tells the viewer why, then closes the session.
func (s *session) endWith(msg wire.SessionEnded) {
	s.mu.Lock()
	dc := s.control
	s.mu.Unlock()
	if dc != nil {
		_ = dc.Send(msg.Marshal())
		// Let SCTP flush the message before the transport goes away.
		time.Sleep(100 * time.Millisecond)
	}
	reason := map[wire.EndReason]string{wire.EndTakenOver: "taken over by " + msg.Detail, wire.EndHostShutdown: "daemon shutting down", wire.EndCaptureError: "capture error"}[msg.Reason]
	s.close(reason)
}

// end closes the session and removes it from the manager if it is still current.
func (s *session) end(reason string) {
	s.close(reason)
	s.m.sessionEnded(s)
}

func (s *session) close(reason string) {
	s.closeOnce.Do(func() {
		slog.Info("desktop session closing", "session", s.id, "reason", reason)
		s.mu.Lock()
		s.closed = true
		close(s.done)
		if s.media != nil {
			s.media.cap.ReleaseAll()
		}
		s.stopMedia()
		wasConnected, uninhibit := s.connected, s.uninhibit
		s.mu.Unlock()
		// pion's Close waits seconds for a live transport to shut down; don't
		// make a viewer taking over wait for it.
		go func() { _ = s.pc.Close() }()
		if uninhibit != nil {
			uninhibit()
		}
		if wasConnected {
			notify(s.hypr, "Remote desktop ended", s.viewer.Name+" disconnected")
		}
	})
}
