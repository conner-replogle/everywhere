package hub

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// A hub that accepts the socket but stops answering pings (like one reached
// over an address that vanished) must be dropped, not waited on forever.
func TestSessionDropsSilentHub(t *testing.T) {
	pingInterval, pongTimeout = 50*time.Millisecond, 100*time.Millisecond
	t.Cleanup(func() { pingInterval, pongTimeout = 15*time.Second, 10*time.Second })

	answer := make(chan bool, 1)
	answer <- true // answer the first ping only
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		for {
			_, raw, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			if string(raw) != protocol.HubPing {
				continue
			}
			select {
			case <-answer:
				conn.Write(r.Context(), websocket.MessageText, []byte(protocol.HubPong))
			default:
			}
		}
	}))
	defer srv.Close()

	c := &Client{Server: srv.URL, OnSignal: func(string, string, protocol.SignalData) {}}
	done := make(chan error, 1)
	go func() { done <- c.session(context.Background()) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("session returned nil error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("session never noticed the hub stopped answering pings")
	}
}

// The hub relays agents' requests as "rpc"; the daemon announces that it
// answers them and replies with rpc.result.
func TestSessionAnswersRPC(t *testing.T) {
	got := make(chan protocol.HubRPCResult, 2)
	hello := make(chan protocol.Hello, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		_, raw, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		var h protocol.Hello
		json.Unmarshal(raw, &h)
		hello <- h
		conn.Write(r.Context(), websocket.MessageText, []byte(`{"t":"rpc","id":"a","method":"echo","params":{"x":1}}`))
		conn.Write(r.Context(), websocket.MessageText, []byte(`{"t":"rpc","id":"b","method":"fail"}`))
		for {
			_, raw, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			var res protocol.HubRPCResult
			if json.Unmarshal(raw, &res) == nil && res.T == "rpc.result" {
				got <- res
			}
		}
	}))
	defer srv.Close()

	c := &Client{
		Server:   srv.URL,
		OnSignal: func(string, string, protocol.SignalData) {},
		OnRPC: func(method string, params json.RawMessage) (any, error) {
			if method == "fail" {
				return nil, errors.New("nope")
			}
			return params, nil
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.session(ctx)

	if h := <-hello; len(h.Features) != 1 || h.Features[0] != protocol.HubFeatureRPC {
		t.Errorf("hello features = %v", h.Features)
	}
	results := map[string]protocol.HubRPCResult{}
	for range 2 {
		select {
		case r := <-got:
			results[r.ID] = r
		case <-time.After(5 * time.Second):
			t.Fatal("no rpc.result")
		}
	}
	if b, _ := json.Marshal(results["a"].Result); string(b) != `{"x":1}` || results["a"].Error != nil {
		t.Errorf("echo = %s %v", b, results["a"].Error)
	}
	if e := results["b"].Error; e == nil || e.Message != "nope" {
		t.Errorf("fail error = %v", e)
	}
}
