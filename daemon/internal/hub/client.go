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

// Vars so tests can shorten them.
var (
	pingInterval = 15 * time.Second
	pongTimeout  = 10 * time.Second
	dialTimeout  = 15 * time.Second
)

type SignalHandler func(from, sid string, data protocol.SignalData)

type Client struct {
	Server     string // e.g. https://ai.replogle.dev
	Credential string
	OnSignal   SignalHandler
	// OnClientRevoked is called when a browser connection's session is signed out.
	OnClientRevoked func(connID string)
	// OnRPC, if set, answers requests relayed from agents using the
	// account's MCP endpoint. It's called on its own goroutine.
	OnRPC func(method string, params json.RawMessage) (any, error)

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
	dctx, cancelDial := context.WithTimeout(ctx, dialTimeout)
	conn, resp, err := websocket.Dial(dctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Authorization": {"Bearer " + c.Credential},
			"X-Ew-Version":  {version.Version},
		},
	})
	cancelDial() // only bounds the handshake
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

	h := protocol.Hello{T: "hello", Version: version.Version}
	if c.OnRPC != nil {
		h.Features = []string{protocol.HubFeatureRPC}
	}
	hello, _ := json.Marshal(h)
	if err := conn.Write(ctx, websocket.MessageText, hello); err != nil {
		return err
	}

	// A socket bound to an address that no longer exists (e.g. after a network
	// change) never errors on its own: writes just queue in the kernel. So each
	// ping must be answered in time, or the connection is treated as dead.
	pong := make(chan struct{}, 1)
	pingCtx, stopPing := context.WithCancel(ctx)
	defer stopPing()
	go func() {
		t := time.NewTicker(pingInterval)
		defer t.Stop()
		for {
			select {
			case <-pingCtx.Done():
				return
			case <-t.C:
			}
			select {
			case <-pong: // drop a stale pong from before this ping
			default:
			}
			wctx, cancel := context.WithTimeout(pingCtx, pongTimeout)
			err := conn.Write(wctx, websocket.MessageText, []byte(protocol.HubPing))
			if err == nil {
				select {
				case <-pong:
				case <-wctx.Done():
					err = wctx.Err()
				}
			}
			cancel()
			if err != nil {
				if pingCtx.Err() == nil {
					slog.Warn("hub didn't answer ping; reconnecting", "err", err)
				}
				conn.CloseNow()
				return
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
			select {
			case pong <- struct{}{}:
			default:
			}
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
		case "client.revoked":
			if c.OnClientRevoked != nil {
				c.OnClientRevoked(msg.ConnID)
			}
		case "rpc":
			if c.OnRPC != nil {
				go c.answer(conn, msg.ID, msg.Method, msg.Params)
			}
		case "error":
			slog.Warn("hub error", "code", msg.Code, "message", msg.Message)
		}
	}
}

// maxRPCResult bounds an answer; the hub's sockets take up to 32 MiB.
const maxRPCResult = 16 << 20

// answer runs one hub RPC request and sends its result.
func (c *Client) answer(conn *websocket.Conn, id, method string, params json.RawMessage) {
	out := protocol.HubRPCResult{T: "rpc.result", ID: id}
	result, err := c.OnRPC(method, params)
	if err == nil {
		out.Result = result
	} else {
		out.Error = &protocol.RPCError{Message: err.Error()}
	}
	b, err := json.Marshal(out)
	if err == nil && len(b) > maxRPCResult {
		err = fmt.Errorf("the answer is too large (%d MB)", len(b)>>20)
	}
	if err != nil {
		b, _ = json.Marshal(protocol.HubRPCResult{T: "rpc.result", ID: id, Error: &protocol.RPCError{Message: err.Error()}})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
		slog.Debug("hub rpc answer", "method", method, "err", err)
	}
}
