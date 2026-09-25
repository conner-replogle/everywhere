package browser

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// TestBrowserVideo streams a tab to a pion peer standing in for a viewer.
func TestBrowserVideo(t *testing.T) {
	if _, err := findChrome(context.Background()); errors.Is(err, ErrNotInstalled) {
		t.Skip(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<!doctype html><title>anim</title><div id=d style="font:40px sans-serif"></div>
<script>setInterval(() => d.textContent = performance.now().toFixed(0), 16)</script>`))
	}))
	defer srv.Close()

	m := NewManager(t.TempDir())
	defer m.Shutdown()
	v := newFakeViewer()
	if err := m.Attach(context.Background(), "p1", v, Viewport{Width: 640, Height: 480, DPR: 1, Video: true}); err != nil {
		t.Fatal(err)
	}
	defer m.Detach("p1", v)
	m.mu.Lock()
	hasVideo := m.chrome.video != nil
	m.mu.Unlock()
	if !hasVideo {
		t.Skip("this browser can't stream video")
	}
	m.Handle("p1", v, protocol.BrowserClientMsg{T: "navigate", URL: srv.URL})

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	var packets atomic.Int64
	pc.OnTrack(func(tr *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			if _, _, err := tr.ReadRTP(); err != nil {
				return
			}
			packets.Add(1)
		}
	})
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	m.Handle("p1", v, protocol.BrowserClientMsg{T: "offer", SDP: pc.LocalDescription().SDP})

	var answer string
	v.waitFor(t, "an answer", func() bool {
		for _, msg := range v.msgs {
			switch msg := msg.(type) {
			case protocol.BrowserAnswer:
				answer = msg.SDP
				return true
			case protocol.BrowserNoVideo:
				t.Fatalf("novideo: %s", msg.Message)
			}
		}
		return false
	})
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer}); err != nil {
		t.Fatal(err)
	}
	// The device's candidates trickle in; add any that came.
	added := 0
	deadline := time.Now().Add(15 * time.Second)
	for packets.Load() < 50 {
		if time.Now().After(deadline) {
			t.Fatalf("got %d RTP packets, state %s", packets.Load(), pc.ConnectionState())
		}
		v.mu.Lock()
		var cands []json.RawMessage
		n := 0
		for _, msg := range v.msgs {
			if c, ok := msg.(protocol.BrowserICE); ok {
				if n >= added {
					cands = append(cands, c.Candidate)
				}
				n++
			}
		}
		v.mu.Unlock()
		for _, c := range cands {
			var init webrtc.ICECandidateInit
			if json.Unmarshal(c, &init) == nil {
				_ = pc.AddICECandidate(init)
			}
			added++
		}
		time.Sleep(50 * time.Millisecond)
	}
	// A new size restarts the capture; the stream carries on.
	before := packets.Load()
	m.Handle("p1", v, protocol.BrowserClientMsg{T: "resize", Width: 400, Height: 700, DPR: 1, Video: true})
	for packets.Load() < before+50 {
		if time.Now().After(deadline.Add(10 * time.Second)) {
			t.Fatalf("no video after a resize (%d packets)", packets.Load()-before)
		}
		time.Sleep(50 * time.Millisecond)
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if len(v.frames) > 0 {
		t.Errorf("a video viewer got %d JPEG frames", len(v.frames))
	}
}
