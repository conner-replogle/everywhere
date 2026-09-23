// Package hub keeps the daemon's signaling WebSocket to the Worker's
// AccountHub open and routes signals to the peer server.
package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/version"
)

// ErrRevoked means the device was removed in the web UI; the daemon should stop.
var ErrRevoked = errors.New("this device was removed from your account; run `everywhere uninstall` or re-enroll")

type SignalHandler func(from, sid string, data protocol.SignalData)

type Client struct {
	Server     string // e.g. https://ai.replogle.dev
	Credential string
	OnSignal   SignalHandler

	conn atomic.Pointer[websocket.Conn]
}

// Run connects and reconnects with backoff until ctx is done or the device is revoked.
func (c *Client) Run(ctx context.Context) error {
	backoff := time.Second
	for {
		start := time.Now()
		err := c.session(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if errors.Is(err, ErrRevoked) {
			return err
		}
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
		slog.Warn("hub disconnected", "err", err, "retry_in", backoff)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

// Send relays a signal to a browser connection. Safe for concurrent use.
func (c *Client) Send(to, sid string, data protocol.SignalData) {
	conn := c.conn.Load()
	if conn == nil {
		return
	}
	b, _ := json.Marshal(protocol.SignalOut{T: "signal", To: to, SID: sid, Data: data})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
		slog.Debug("hub send", "err", err)
	}
}

func (c *Client) session(ctx context.Context) error {
	url := strings.Replace(strings.TrimRight(c.Server, "/"), "http", "ws", 1) + "/api/daemon/ws"
	conn, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Authorization": {"Bearer " + c.Credential},
			"X-Ew-Version":  {version.Version},
		},
	})
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return ErrRevoked
		}
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)
	c.conn.Store(conn)
	defer c.conn.Store(nil)
	slog.Info("connected to hub", "server", c.Server)

	hello, _ := json.Marshal(protocol.Hello{T: "hello", Version: version.Version})
	if err := conn.Write(ctx, websocket.MessageText, hello); err != nil {
		return err
	}

	pingCtx, stopPing := context.WithCancel(ctx)
	defer stopPing()
	go func() {
		t := time.NewTicker(25 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-pingCtx.Done():
				return
			case <-t.C:
				wctx, cancel := context.WithTimeout(pingCtx, 10*time.Second)
				err := conn.Write(wctx, websocket.MessageText, []byte(protocol.HubPing))
				cancel()
				if err != nil {
					conn.CloseNow()
					return
				}
			}
		}
	}()

	for {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			switch websocket.CloseStatus(err) {
			case 4003:
				return ErrRevoked
			case 4001:
				return fmt.Errorf("daemon is too old for this server; run `everywhere update`")
			}
			return err
		}
		if string(raw) == protocol.HubPong {
			continue
		}
		var msg protocol.HubToDaemon
		if err := json.Unmarshal(raw, &msg); err != nil {
			slog.Warn("bad hub message", "err", err)
			continue
		}
		switch msg.T {
		case "signal":
			c.OnSignal(msg.From, msg.SID, msg.Data)
		case "error":
			slog.Warn("hub error", "code", msg.Code, "message", msg.Message)
		}
	}
}
