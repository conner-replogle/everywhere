package hub

import (
	"context"
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
