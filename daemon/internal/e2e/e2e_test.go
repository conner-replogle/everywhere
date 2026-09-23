// Package e2e drives a running Worker + daemon the way a browser would:
// hub WebSocket for signaling, then WebRTC control RPC and a terminal channel.
//
// Run with a local stack (see README):
//
//	EW_E2E_SERVER=http://localhost:8799 EW_E2E_COOKIE='__Host-ew_session=...' EW_E2E_DEVICE=<id> go test ./internal/e2e -v
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

type hubMsg struct {
	T      string              `json:"t"`
	From   string              `json:"from"`
	SID    string              `json:"sid"`
	Data   protocol.SignalData `json:"data"`
	Online []string            `json:"online"`
	Code   string              `json:"code"`
}

func TestEndToEnd(t *testing.T) {
	server, cookie, device := os.Getenv("EW_E2E_SERVER"), os.Getenv("EW_E2E_COOKIE"), os.Getenv("EW_E2E_DEVICE")
	if server == "" {
		t.Skip("EW_E2E_SERVER not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	ws, _, err := websocket.Dial(ctx, strings.Replace(server, "http", "ws", 1)+"/api/ws", &websocket.DialOptions{
		HTTPHeader: http.Header{"Cookie": {cookie}, "Origin": {server}},
	})
	if err != nil {
		t.Fatalf("dial hub: %v", err)
	}
	defer ws.CloseNow()

	var first hubMsg
	readJSON(t, ctx, ws, &first)
	if first.T != "presence" || !contains(first.Online, device) {
		t.Fatalf("expected device %s online in presence, got %+v", device, first)
	}

	// EW_E2E_RELAY=1 forces the connection through the TURN relay.
	cfg := webrtc.Configuration{}
	if os.Getenv("EW_E2E_RELAY") != "" {
		cfg = relayConfig(t, server, cookie)
	}
	pc, err := webrtc.NewPeerConnection(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	sid := fmt.Sprintf("e2e-%d", time.Now().UnixNano())
	send := func(data protocol.SignalData) {
		b, _ := json.Marshal(map[string]any{"t": "signal", "to": device, "sid": sid, "data": data})
		if err := ws.Write(ctx, websocket.MessageText, b); err != nil {
			t.Errorf("hub write: %v", err)
		}
	}
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		j := c.ToJSON()
		send(protocol.SignalData{Type: "candidate", Candidate: &protocol.IceCandidate{Candidate: j.Candidate, SDPMid: j.SDPMid, SDPMLineIndex: j.SDPMLineIndex}})
	})

	control, err := pc.CreateDataChannel(protocol.ControlChannel, nil)
	if err != nil {
		t.Fatal(err)
	}
	rpc := newRPC(control)
	controlOpen := make(chan struct{})
	control.OnOpen(func() { close(controlOpen) })

	offer, _ := pc.CreateOffer(nil)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	send(protocol.SignalData{Type: "offer", SDP: offer.SDP})

	// Pump hub messages into the peer connection.
	go func() {
		for {
			var m hubMsg
			_, raw, err := ws.Read(ctx)
			if err != nil {
				return
			}
			if json.Unmarshal(raw, &m) != nil || m.SID != sid {
				continue
			}
			switch m.Data.Type {
			case "answer":
				if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: m.Data.SDP}); err != nil {
					t.Errorf("set answer: %v", err)
				}
			case "candidate":
				c := m.Data.Candidate
				_ = pc.AddICECandidate(webrtc.ICECandidateInit{Candidate: c.Candidate, SDPMid: c.SDPMid, SDPMLineIndex: c.SDPMLineIndex})
			}
		}
	}()

	select {
	case <-controlOpen:
	case <-ctx.Done():
		t.Fatal("control channel never opened")
	}

	var info protocol.DeviceInfo
	rpc.call(t, "device.info", nil, &info)
	t.Logf("device.info: %+v", info)

	var dbg protocol.PeerDebug
	rpc.call(t, "debug.peer", nil, &dbg)
	if dbg.SID != sid || dbg.SelectedPair == nil || dbg.ConnectionState != "connected" || len(dbg.Interfaces) == 0 {
		t.Errorf("debug.peer = %+v", dbg)
	} else if cfg.ICETransportPolicy == webrtc.ICETransportPolicyRelay && dbg.SelectedPair.Remote.Type != "relay" {
		t.Errorf("expected the daemon to see a relay candidate, got %+v", dbg.SelectedPair)
	} else {
		t.Logf("debug.peer: selected %s %s:%d <-> %s %s:%d", dbg.SelectedPair.Local.Type, dbg.SelectedPair.Local.Address,
			dbg.SelectedPair.Local.Port, dbg.SelectedPair.Remote.Type, dbg.SelectedPair.Remote.Address, dbg.SelectedPair.Remote.Port)
	}

	var projects []protocol.Project
	rpc.call(t, "projects.list", nil, &projects)
	if len(projects) == 0 || !projects[0].IsHome {
		t.Fatalf("expected home project first, got %+v", projects)
	}

	var thread protocol.Thread
	rpc.call(t, "threads.create", map[string]string{"projectId": projects[0].ID}, &thread)
	defer rpc.call(t, "threads.delete", map[string]string{"id": thread.ID}, nil)

	var dirs protocol.DirListing
	rpc.call(t, "fs.listDirs", map[string]string{"path": "~"}, &dirs)
	if dirs.Path != info.Home {
		t.Errorf("fs.listDirs ~ = %q, want %q", dirs.Path, info.Home)
	}

	// Two terminal clients on the same thread: first is writer, second read-only.
	a := openTerm(t, pc, thread.ID)
	a.expectWriter(t, true)
	b := openTerm(t, pc, thread.ID)
	b.expectWriter(t, false)

	marker := fmt.Sprintf("everywhere-%d", time.Now().UnixNano())
	_ = b.dc.Send([]byte("echo ignored-" + marker + "\r")) // dropped: b isn't the writer
	_ = a.dc.Send([]byte("echo " + marker + "\r"))
	a.waitOutput(t, marker+"\r\n")
	b.waitOutput(t, marker+"\r\n")
	if a.saw("ignored-" + marker) {
		t.Error("read-only client's input reached the shell")
	}

	// b takes over; a becomes read-only.
	_ = b.dc.SendText(`{"t":"takeover","cols":100,"rows":30}`)
	b.expectWriter(t, true)
	a.expectWriter(t, false)

	_ = b.dc.Send([]byte("exit\r"))
	a.waitExit(t)
	b.waitExit(t)

	var threads []protocol.Thread
	rpc.call(t, "threads.list", map[string]string{"projectId": projects[0].ID}, &threads)
	for _, th := range threads {
		if th.ID == thread.ID && th.Running {
			t.Error("thread still running after exit")
		}
	}

	// Reattaching respawns the shell with the restart notice.
	c := openTerm(t, pc, thread.ID)
	c.expectWriter(t, true)
	c.waitOutput(t, "previous session ended")
}

// --- helpers ------------------------------------------------------------------

func relayConfig(t *testing.T, server, cookie string) webrtc.Configuration {
	t.Helper()
	req, _ := http.NewRequest("GET", server+"/api/ice-servers", nil)
	req.Header.Set("Cookie", cookie)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		IceServers []struct {
			URLs       []string `json:"urls"`
			Username   string   `json:"username"`
			Credential string   `json:"credential"`
		} `json:"iceServers"`
		Turn bool `json:"turn"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || !out.Turn {
		t.Fatalf("no TURN servers from /api/ice-servers (turn=%v, err=%v)", out.Turn, err)
	}
	cfg := webrtc.Configuration{ICETransportPolicy: webrtc.ICETransportPolicyRelay}
	for _, s := range out.IceServers {
		cfg.ICEServers = append(cfg.ICEServers, webrtc.ICEServer{URLs: s.URLs, Username: s.Username, Credential: s.Credential})
	}
	return cfg
}

func readJSON(t *testing.T, ctx context.Context, ws *websocket.Conn, v any) {
	t.Helper()
	_, raw, err := ws.Read(ctx)
	if err != nil {
		t.Fatalf("hub read: %v", err)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("hub decode %s: %v", raw, err)
	}
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

type rpcClient struct {
	dc      *webrtc.DataChannel
	mu      sync.Mutex
	next    int64
	pending map[int64]chan json.RawMessage
}

func newRPC(dc *webrtc.DataChannel) *rpcClient {
	r := &rpcClient{dc: dc, pending: map[int64]chan json.RawMessage{}}
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		var head struct {
			ID    *int64 `json:"id"`
			Event string `json:"event"`
		}
		if json.Unmarshal(m.Data, &head) != nil || head.ID == nil {
			return
		}
		r.mu.Lock()
		ch := r.pending[*head.ID]
		delete(r.pending, *head.ID)
		r.mu.Unlock()
		if ch != nil {
			ch <- m.Data
		}
	})
	return r
}

func (r *rpcClient) call(t *testing.T, method string, params any, out any) {
	t.Helper()
	if params == nil {
		params = map[string]any{}
	}
	r.mu.Lock()
	r.next++
	id := r.next
	ch := make(chan json.RawMessage, 1)
	r.pending[id] = ch
	r.mu.Unlock()
	b, _ := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err := r.dc.SendText(string(b)); err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	select {
	case raw := <-ch:
		var resp struct {
			Result json.RawMessage `json:"result"`
			Error  *struct{ Message string }
		}
		_ = json.Unmarshal(raw, &resp)
		if resp.Error != nil {
			t.Fatalf("%s: %s", method, resp.Error.Message)
		}
		if out != nil {
			if err := json.Unmarshal(resp.Result, out); err != nil {
				t.Fatalf("%s decode: %v", method, err)
			}
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("%s: timeout", method)
	}
}

type termConn struct {
	dc     *webrtc.DataChannel
	mu     sync.Mutex
	out    bytes.Buffer
	writer chan bool
	exited chan int
}

func openTerm(t *testing.T, pc *webrtc.PeerConnection, threadID string) *termConn {
	t.Helper()
	dc, err := pc.CreateDataChannel(protocol.TermChannelPrefix+threadID, nil)
	if err != nil {
		t.Fatal(err)
	}
	tc := &termConn{dc: dc, writer: make(chan bool, 8), exited: make(chan int, 1)}
	dc.OnOpen(func() { _ = dc.SendText(`{"t":"attach","cols":80,"rows":24}`) })
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if !m.IsString {
			tc.mu.Lock()
			tc.out.Write(m.Data)
			tc.mu.Unlock()
			return
		}
		var msg struct {
			T       string `json:"t"`
			You     bool   `json:"you"`
			Code    int    `json:"code"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(m.Data, &msg)
		switch msg.T {
		case "writer":
			tc.writer <- msg.You
		case "exited":
			tc.exited <- msg.Code
		case "error":
			t.Errorf("term error: %s", msg.Message)
		}
	})
	return tc
}

func (tc *termConn) expectWriter(t *testing.T, want bool) {
	t.Helper()
	select {
	case got := <-tc.writer:
		if got != want {
			t.Fatalf("writer = %v, want %v", got, want)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no writer status")
	}
}

func (tc *termConn) saw(s string) bool {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	return strings.Contains(tc.out.String(), s)
}

func (tc *termConn) waitOutput(t *testing.T, s string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if tc.saw(s) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	tc.mu.Lock()
	defer tc.mu.Unlock()
	t.Fatalf("output never contained %q; got:\n%s", s, tc.out.String())
}

func (tc *termConn) waitExit(t *testing.T) {
	t.Helper()
	select {
	case <-tc.exited:
	case <-time.After(10 * time.Second):
		t.Fatal("shell never exited")
	}
}
