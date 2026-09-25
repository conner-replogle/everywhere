package desktop

import (
	"log/slog"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/wire"
)

// Linux BTN_* codes.
const (
	btnLeft   = 0x110
	btnRight  = 0x111
	btnMiddle = 0x112
	btnSide   = 0x113
	btnExtra  = 0x114
)

var domButtons = map[uint8]uint32{
	wire.ButtonLeft:    btnLeft,
	wire.ButtonMiddle:  btnMiddle,
	wire.ButtonRight:   btnRight,
	wire.ButtonBack:    btnSide,
	wire.ButtonForward: btnExtra,
}

// controller applies the viewer's data channel messages to the host.
type controller struct {
	sess  *session
	mu    sync.Mutex
	moved bool
	seq   uint16
}

func (c *controller) attach(dc *webrtc.DataChannel) {
	switch dc.Label() {
	case wire.ChannelInput, wire.ChannelControl:
	default:
		slog.Warn("unknown desktop data channel", "label", dc.Label())
		_ = dc.Close()
		return
	}
	dc.OnOpen(func() {
		if dc.Label() == wire.ChannelControl {
			c.sess.setControl(dc)
		}
	})
	dc.OnClose(func() { c.apply(wire.ReleaseAll{}) })
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		received := time.Now()
		msg, err := wire.Parse(m.Data)
		if err != nil {
			slog.Debug("bad desktop message", "channel", dc.Label(), "err", err)
			return
		}
		switch m := msg.(type) {
		case wire.Ping:
			_ = dc.Send(wire.Pong{Seq: m.Seq, ClientMs: m.ClientMs, HostUs: uint32(time.Since(received).Microseconds())}.Marshal())
			return
		case wire.SelectOutput:
			go c.sess.selectOutput(m.Name)
			return
		case wire.Workspace:
			go c.sess.showWorkspace(m.ID)
			return
		case wire.SetFollow:
			go c.sess.setFollow(m.On)
			return
		case wire.SelectWindow:
			go c.sess.selectWindow(m.ID)
			return
		case wire.FocusWindow:
			go c.sess.focusWindow(m.ID)
			return
		case wire.Clipboard:
			go c.sess.setClipboard(m.Text)
			return
		case wire.SetClipSync:
			c.sess.setClipSync(m.On)
			return
		case wire.SetMode:
			go c.sess.setMode(m.Mode)
			return
		}
		if msg != nil {
			c.apply(msg)
		}
	})
}

func (c *controller) apply(msg any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	w, win := c.sess.input()
	if w == nil {
		return
	}
	// A window stream maps the pointer from the window onto its monitor, and
	// focuses the window before a click or key, so input can only reach it.
	at := func(x, y uint16) (uint16, uint16) {
		if win == nil {
			return x, y
		}
		return win.toMonitor(x, y)
	}
	switch m := msg.(type) {
	case wire.Move:
		if c.moved && !wire.Newer(m.Seq, c.seq) {
			return
		}
		c.moved, c.seq = true, m.Seq
		w.Motion(at(m.X, m.Y))
	case wire.Button:
		if code, ok := domButtons[m.Button]; ok {
			if win != nil && m.Pressed {
				c.sess.focusCaptured(win)
			}
			x, y := at(m.X, m.Y)
			w.Button(code, m.Pressed, x, y)
		}
	case wire.Scroll:
		w.Scroll(m.Continuous, float64(m.DX), float64(m.DY))
	case wire.Key:
		if win != nil {
			if m.Code == keyLeftMeta || m.Code == keyRightMeta {
				return
			}
			if m.Pressed {
				c.sess.focusCaptured(win)
			}
		}
		w.Key(uint32(m.Code), m.Pressed)
	case wire.ReleaseAll:
		w.ReleaseAll()
	}
}
