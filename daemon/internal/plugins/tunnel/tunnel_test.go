package tunnel

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestLoopback(t *testing.T) {
	for host, want := range map[string]bool{
		"localhost": true, "LOCALHOST.": true, "app.localhost": true, "127.0.0.1": true, "127.9.9.9": true,
		"::1": true, "[::1]": true, "0.0.0.0": true,
		"example.com": false, "10.0.0.1": false, "192.168.1.2": false, "localhost.example.com": false, "": false,
	} {
		if got := loopback(host); got != want {
			t.Errorf("loopback(%q) = %v, want %v", host, got, want)
		}
	}
}

// pair connects two peer connections in this process and returns the
// client's channel, label "tcp:1", with the daemon side served.
func pair(t *testing.T) *webrtc.DataChannel {
	t.Helper()
	client, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	daemon, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		cancel()
		client.Close()
		daemon.Close()
	})
	daemon.OnDataChannel(func(dc *webrtc.DataChannel) {
		dc.OnOpen(func() {
			chCtx, done := context.WithCancel(ctx)
			dc.OnClose(done)
			serve(chCtx, dc)
		})
	})
	dc, err := client.CreateDataChannel("tcp:1", nil)
	if err != nil {
		t.Fatal(err)
	}
	offer, _ := client.CreateOffer(nil)
	g := webrtc.GatheringCompletePromise(client)
	if err := client.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-g
	if err := daemon.SetRemoteDescription(*client.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, _ := daemon.CreateAnswer(nil)
	g = webrtc.GatheringCompletePromise(daemon)
	if err := daemon.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	<-g
	if err := client.SetRemoteDescription(*daemon.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	return dc
}

type event struct {
	text string
	data []byte
}

func collect(dc *webrtc.DataChannel) <-chan event {
	out := make(chan event, 64)
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if m.IsString {
			out <- event{text: string(m.Data)}
		} else {
			out <- event{data: append([]byte(nil), m.Data...)}
		}
	})
	return out
}

func next(t *testing.T, ch <-chan event) event {
	t.Helper()
	select {
	case e := <-ch:
		return e
	case <-time.After(10 * time.Second):
		t.Fatal("nothing came")
		return event{}
	}
}

func dialMsg(host string, port int) string {
	b, _ := json.Marshal(map[string]any{"t": "dial", "host": host, "port": port})
	return string(b)
}

func TestTunnelRelaysBothWays(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	// The port answers what it's sent, upper-cased, then closes.
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		buf := make([]byte, 64)
		n, _ := io.ReadAtLeast(c, buf, 5)
		_, _ = c.Write([]byte(strings.ToUpper(string(buf[:n]))))
		c.Close()
	}()

	dc := pair(t)
	msgs := collect(dc)
	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	<-opened
	// Bytes sent before the daemon says open wait for the connection.
	_ = dc.SendText(dialMsg("localhost", ln.Addr().(*net.TCPAddr).Port))
	_ = dc.Send([]byte("hello"))

	if e := next(t, msgs); e.text != `{"t":"open"}` {
		t.Fatalf("first message %q, want open", e.text)
	}
	var got []byte
	for {
		e := next(t, msgs)
		if e.text == `{"t":"end"}` {
			break
		}
		if e.text != "" {
			t.Fatalf("unexpected %q", e.text)
		}
		got = append(got, e.data...)
	}
	if string(got) != "HELLO" {
		t.Fatalf("got %q, want HELLO", got)
	}
}

func TestTunnelRefusesOtherHosts(t *testing.T) {
	dc := pair(t)
	msgs := collect(dc)
	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	<-opened
	_ = dc.SendText(dialMsg("example.com", 80))
	e := next(t, msgs)
	if !strings.Contains(e.text, `"t":"error"`) || !strings.Contains(e.text, "isn't this device") {
		t.Fatalf("got %q, want a refusal", e.text)
	}
}
