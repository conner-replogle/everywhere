package peer

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// testBrowser is the browser's end of a connection to s, signaling straight
// to it instead of through the hub.
type testBrowser struct {
	t   *testing.T
	s   *Server
	sid string
	pc  *webrtc.PeerConnection
	dc  *webrtc.DataChannel

	mu      sync.Mutex // HandleSignal is called serially, as the hub does
	conn    string     // the browser's current hub connection
	answers chan string
	byes    chan struct{}
	replies chan protocol.RPCResponse
}

func newTestBrowser(t *testing.T, s *Server) *testBrowser {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	b := &testBrowser{
		t: t, s: s, sid: "sid1", pc: pc, conn: "conn1",
		answers: make(chan string, 4), byes: make(chan struct{}, 4), replies: make(chan protocol.RPCResponse, 4),
	}
	s.SetSignaler(func(to, sid string, data protocol.SignalData) {
		switch data.Type {
		case "answer":
			if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: data.SDP}); err != nil {
				t.Errorf("set answer: %v", err)
			}
			b.answers <- to
		case "candidate":
			c := data.Candidate
			_ = pc.AddICECandidate(webrtc.ICECandidateInit{Candidate: c.Candidate, SDPMid: c.SDPMid, SDPMLineIndex: c.SDPMLineIndex})
		case "bye":
			b.byes <- struct{}{}
		}
	})
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		b.signal(protocol.SignalData{Type: "candidate", Candidate: &protocol.IceCandidate{
			Candidate: init.Candidate, SDPMid: init.SDPMid, SDPMLineIndex: init.SDPMLineIndex,
		}})
	})
	return b
}

func (b *testBrowser) signal(data protocol.SignalData) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.s.HandleSignal(b.conn, b.sid, data)
}

func (b *testBrowser) offer(restart bool) {
	b.t.Helper()
	offer, err := b.pc.CreateOffer(&webrtc.OfferOptions{ICERestart: restart})
	if err != nil {
		b.t.Fatal(err)
	}
	if err := b.pc.SetLocalDescription(offer); err != nil {
		b.t.Fatal(err)
	}
	b.signal(protocol.SignalData{Type: "offer", SDP: offer.SDP, Restart: restart})
}

func (b *testBrowser) waitAnswer() string {
	b.t.Helper()
	select {
	case to := <-b.answers:
		return to
	case <-b.byes:
		b.t.Fatal("got bye, want an answer")
	case <-time.After(10 * time.Second):
		b.t.Fatal("no answer")
	}
	return ""
}

// ask calls device.info on the control channel and waits for the reply.
func (b *testBrowser) ask(id int64) {
	b.t.Helper()
	msg, _ := json.Marshal(protocol.RPCRequest{ID: id, Method: "device.info"})
	if err := b.dc.SendText(string(msg)); err != nil {
		b.t.Fatal(err)
	}
	select {
	case r := <-b.replies:
		if r.ID != id || r.Error != nil {
			b.t.Fatalf("reply %+v, want a result for %d", r, id)
		}
	case <-time.After(10 * time.Second):
		b.t.Fatalf("no reply to %d", id)
	}
}

// An ICE restart keeps the connection: the control channel opened before it
// still answers, and the daemon answers the browser's new hub connection.
func TestICERestartKeepsConnection(t *testing.T) {
	s := testServer(t)
	b := newTestBrowser(t, s)
	dc, err := b.pc.CreateDataChannel(protocol.ControlChannel, nil)
	if err != nil {
		t.Fatal(err)
	}
	b.dc = dc
	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		var r protocol.RPCResponse
		if json.Unmarshal(m.Data, &r) == nil && r.ID != 0 {
			b.replies <- r
		}
	})

	b.offer(false)
	b.waitAnswer()
	select {
	case <-opened:
	case <-time.After(10 * time.Second):
		t.Fatal("control channel never opened")
	}
	b.ask(1)

	// The browser's hub socket was replaced while it was away.
	b.mu.Lock()
	b.conn = "conn2"
	b.mu.Unlock()
	b.offer(true)
	if to := b.waitAnswer(); to != "conn2" {
		t.Fatalf("restart answer went to %q, want conn2", to)
	}
	b.ask(2)
	if got := s.peer(b.sid).Client(); got != "conn2" {
		t.Fatalf("peer's client is %q, want conn2", got)
	}
	if dc.ReadyState() != webrtc.DataChannelStateOpen {
		t.Fatalf("control channel %s after restart", dc.ReadyState())
	}
}

// A connection the daemon no longer has can't be restarted: bye tells the
// browser to make a new one.
func TestICERestartOfUnknownConnection(t *testing.T) {
	s := testServer(t)
	b := newTestBrowser(t, s)
	if _, err := b.pc.CreateDataChannel(protocol.ControlChannel, nil); err != nil {
		t.Fatal(err)
	}
	offer, err := b.pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	b.signal(protocol.SignalData{Type: "offer", SDP: offer.SDP, Restart: true})
	select {
	case <-b.byes:
	case to := <-b.answers:
		t.Fatalf("restart of an unknown connection answered (to %s), want bye", to)
	case <-time.After(5 * time.Second):
		t.Fatal("no bye")
	}
	if s.peer(b.sid) != nil {
		t.Fatal("restart of an unknown connection made one")
	}
}
