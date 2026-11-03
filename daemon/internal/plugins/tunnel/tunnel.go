// Package tunnel is the tunnel plugin: tcp:<id> channels, each a TCP
// connection the daemon makes to one of the device's own ports. The desktop
// app's web tabs reach the device's localhost (a dev server, its hot
// reload's websocket) through them.
package tunnel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/termchan"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

const dialTimeout = 10 * time.Second

// Plugin is the tunnel plugin.
type Plugin struct{}

// New makes the tunnel plugin.
func New() *Plugin { return &Plugin{} }

func (p *Plugin) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID: "tunnel", Title: "Tunnel", API: plugin.API, Builtin: true,
		Permissions: []string{plugin.PermNetLoopback, plugin.PermRemote},
	}
}

func (p *Plugin) Start(h plugin.Host) error {
	h.HandleChannel(protocol.TCPChannelPrefix, func(ctx context.Context, _ plugin.ChannelContext, dc *webrtc.DataChannel) {
		serve(ctx, dc)
	})
	return nil
}

func (p *Plugin) Stop() {}

// loopback reports whether host names this machine, the only place a
// tunnel goes.
func loopback(host string) bool {
	h := strings.ToLower(strings.TrimSuffix(host, "."))
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(h, "[]"))
	return ip != nil && (ip.IsLoopback() || ip.IsUnspecified())
}

// dial connects to a port of this machine: the host as asked, except names
// of it, which go to whichever loopback address is listening (dev servers
// listen on either 127.0.0.1 or ::1).
func dial(ctx context.Context, host string, port int) (net.Conn, error) {
	if !loopback(host) {
		return nil, fmt.Errorf("%s isn't this device: tunnels only reach its own ports", host)
	}
	if port < 1 || port > 65535 {
		return nil, errors.New("no such port")
	}
	d := net.Dialer{Timeout: dialTimeout}
	p := strconv.Itoa(port)
	ip := net.ParseIP(strings.Trim(host, "[]"))
	if ip != nil && !ip.IsUnspecified() {
		return d.DialContext(ctx, "tcp", net.JoinHostPort(ip.String(), p))
	}
	c, err := d.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", p))
	if err == nil {
		return c, nil
	}
	if c6, err6 := d.DialContext(ctx, "tcp", net.JoinHostPort("::1", p)); err6 == nil {
		return c6, nil
	}
	return nil, err
}

// serve runs one tcp:<id> channel: the client's dial request, then bytes
// both ways as binary messages until either side closes.
func serve(ctx context.Context, dc *webrtc.DataChannel) {
	send := func(msg any) error {
		b, _ := json.Marshal(msg)
		return dc.SendText(string(b))
	}
	low := make(chan struct{}, 1)
	dc.SetBufferedAmountLowThreshold(termchan.MaxChunk * 16)
	dc.OnBufferedAmountLow(func() {
		select {
		case low <- struct{}{}:
		default:
		}
	})

	var (
		mu      sync.Mutex
		conn    net.Conn
		pending [][]byte // bytes that came before the connection
		dialing bool
	)
	go func() {
		<-ctx.Done()
		mu.Lock()
		defer mu.Unlock()
		if conn != nil {
			conn.Close()
		}
	}()

	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if !msg.IsString {
			mu.Lock()
			c := conn
			if c == nil {
				pending = append(pending, append([]byte(nil), msg.Data...))
			}
			mu.Unlock()
			if c != nil {
				// Blocking here holds the channel's reads: the client's sending waits on the port.
				if _, err := c.Write(msg.Data); err != nil {
					_ = dc.Close()
				}
			}
			return
		}
		var req protocol.TCPDial
		if json.Unmarshal(msg.Data, &req) != nil || req.T != "dial" {
			return
		}
		mu.Lock()
		if dialing {
			mu.Unlock()
			return
		}
		dialing = true
		mu.Unlock()
		go func() {
			c, err := dial(ctx, req.Host, req.Port)
			slog.Debug("tunnel dial", "host", req.Host, "port", req.Port, "err", err)
			if err != nil {
				_ = send(protocol.TCPError{T: "error", Message: err.Error()})
				_ = dc.Close()
				return
			}
			mu.Lock()
			if ctx.Err() != nil {
				mu.Unlock()
				c.Close()
				return
			}
			for _, b := range pending {
				if _, err := c.Write(b); err != nil {
					break
				}
			}
			conn, pending = c, nil
			mu.Unlock()
			if send(map[string]string{"t": "open"}) != nil {
				c.Close()
				return
			}
			pump(c, dc, low, ctx.Done())
			_ = send(map[string]string{"t": "end"})
			_ = dc.Close()
		}()
	})
}

// pump sends what the port says until it closes, keeping the channel's
// buffer bounded.
func pump(c net.Conn, dc *webrtc.DataChannel, low, closed <-chan struct{}) {
	defer c.Close()
	buf := make([]byte, termchan.MaxChunk)
	for {
		n, err := c.Read(buf)
		if n > 0 {
			for dc.BufferedAmount() > termchan.MaxChunk*64 {
				select {
				case <-low:
				case <-closed:
					return
				}
			}
			if dc.Send(buf[:n]) != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}
