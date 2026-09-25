// Package wire encodes the messages on a remote desktop session's own data
// channels (binary, little-endian; the first byte is the type). It is
// omarchote's protocol; apps/web/src/lib/desktop/protocol.ts mirrors this file.
package wire

import (
	"encoding/binary"
	"errors"
	"math"
	"unicode/utf8"
)

const (
	ChannelInput   = "input"   // unordered, maxRetransmits=0
	ChannelControl = "control" // reliable, ordered
)

// Viewer → host.
const (
	TypeMove         byte = 0x01 // input channel
	TypeButton       byte = 0x02
	TypeScroll       byte = 0x03
	TypeKey          byte = 0x04
	TypeReleaseAll   byte = 0x05
	TypePing         byte = 0x06
	TypeSelectOutput byte = 0x07
	TypeSetMode      byte = 0x08
	TypeWorkspace    byte = 0x09 // switch to a workspace (Hyprland focuses its monitor)
	TypeSetFollow    byte = 0x0a // follow the focused monitor
	TypeSelectWindow byte = 0x0b // capture one window
	TypeFocusWindow  byte = 0x0c // focus a window (and show its workspace)
	TypeClipboard    byte = 0x0d // the viewer's clipboard text
	TypeSetClipSync  byte = 0x0e // exchange clipboard text or not
)

// Host → viewer.
const (
	TypeHello          byte = 0x80
	TypeCursorImage    byte = 0x81
	TypeCursorPosition byte = 0x82
	TypeOutputs        byte = 0x83
	TypeModeInfo       byte = 0x84
	TypeSessionEnded   byte = 0x85
	TypePeerInfo       byte = 0x87
	TypePong           byte = 0x86
	TypeWorkspaces     byte = 0x88
	TypeWindows        byte = 0x89
	TypeHostClipboard  byte = 0x8a
)

// MaxClipboard bounds clipboard text in either direction; SCTP messages over
// 256 KiB aren't portable.
const MaxClipboard = 200 << 10

// DOM MouseEvent.button values.
const (
	ButtonLeft    = 0
	ButtonMiddle  = 1
	ButtonRight   = 2
	ButtonBack    = 3
	ButtonForward = 4
)

var ErrShort = errors.New("message too short")
var le = binary.LittleEndian

type Move struct {
	Seq  uint16
	X, Y uint16 // 0..65535 across the video frame
}

type Button struct {
	Button  uint8
	Pressed bool
	X, Y    uint16
}

type Scroll struct {
	Continuous bool // pixels (touchpad) vs wheel notches
	DX, DY     float32
}

type Key struct {
	Code    uint16 // Linux KEY_* code
	Pressed bool
}

type Ping struct {
	Seq      uint32
	ClientMs float64
}

type ReleaseAll struct{}

type Mode uint8

const (
	ModeSharp        Mode = 0
	ModeSmooth       Mode = 1
	ModeLowBandwidth Mode = 2
)

// ParseMode accepts the names desktop.start takes.
func ParseMode(s string) (Mode, bool) {
	switch s {
	case "sharp":
		return ModeSharp, true
	case "smooth":
		return ModeSmooth, true
	case "low":
		return ModeLowBandwidth, true
	}
	return 0, false
}

type SetMode struct {
	Mode Mode
}

type SelectOutput struct {
	Name string
}

// Workspace asks the host to show workspace ID.
type Workspace struct {
	ID int32
}

// SetFollow turns following the focused monitor on or off: the capture
// switches to whichever monitor Hyprland focuses.
type SetFollow struct {
	On bool
}

// SelectWindow captures one window, by the ID from Windows.
type SelectWindow struct {
	ID string
}

// FocusWindow focuses a window, switching to its workspace.
type FocusWindow struct {
	ID string
}

// Clipboard is clipboard text, from the viewer (TypeClipboard) or the host
// (TypeHostClipboard): u32 length, then UTF-8.
type Clipboard struct {
	Text string
}

// SetClipSync turns clipboard exchange on or off (off until the viewer asks).
type SetClipSync struct {
	On bool
}

// Parse decodes one viewer → host message. Unknown types return (nil, nil) so
// newer viewers can talk to older hosts.
func Parse(b []byte) (any, error) {
	if len(b) == 0 {
		return nil, ErrShort
	}
	need := map[byte]int{
		TypeMove: 7, TypeButton: 7, TypeScroll: 10, TypeKey: 4, TypeReleaseAll: 1, TypePing: 13, TypeSelectOutput: 2,
		TypeSetMode: 2, TypeWorkspace: 5, TypeSetFollow: 2, TypeSelectWindow: 2, TypeFocusWindow: 2, TypeClipboard: 5,
		TypeSetClipSync: 2,
	}
	n, known := need[b[0]]
	if !known {
		return nil, nil
	}
	if len(b) < n {
		return nil, ErrShort
	}
	switch b[0] {
	case TypeMove:
		return Move{Seq: le.Uint16(b[1:]), X: le.Uint16(b[3:]), Y: le.Uint16(b[5:])}, nil
	case TypeButton:
		return Button{Button: b[1], Pressed: b[2] != 0, X: le.Uint16(b[3:]), Y: le.Uint16(b[5:])}, nil
	case TypeScroll:
		return Scroll{Continuous: b[1] != 0, DX: math.Float32frombits(le.Uint32(b[2:])), DY: math.Float32frombits(le.Uint32(b[6:]))}, nil
	case TypeKey:
		return Key{Code: le.Uint16(b[1:]), Pressed: b[3] != 0}, nil
	case TypeReleaseAll:
		return ReleaseAll{}, nil
	case TypeSelectOutput:
		n := int(b[1])
		if len(b) < 2+n {
			return nil, ErrShort
		}
		return SelectOutput{Name: string(b[2 : 2+n])}, nil
	case TypeSetMode:
		return SetMode{Mode: Mode(b[1])}, nil
	case TypeWorkspace:
		return Workspace{ID: int32(le.Uint32(b[1:]))}, nil
	case TypeSetFollow:
		return SetFollow{On: b[1] != 0}, nil
	case TypeSelectWindow, TypeFocusWindow:
		n := int(b[1])
		if len(b) < 2+n {
			return nil, ErrShort
		}
		if b[0] == TypeSelectWindow {
			return SelectWindow{ID: string(b[2 : 2+n])}, nil
		}
		return FocusWindow{ID: string(b[2 : 2+n])}, nil
	case TypeClipboard:
		n := int(le.Uint32(b[1:]))
		if n > MaxClipboard || len(b) < 5+n {
			return nil, ErrShort
		}
		return Clipboard{Text: string(b[5 : 5+n])}, nil
	case TypeSetClipSync:
		return SetClipSync{On: b[1] != 0}, nil
	case TypePing:
		return Ping{Seq: le.Uint32(b[1:]), ClientMs: math.Float64frombits(le.Uint64(b[5:]))}, nil
	}
	return nil, nil
}

// Hello says what is being captured: u16 width, u16 height, str output,
// then (newer hosts) str window, str class, str title. Window is empty when a
// whole monitor is captured; Output is then that monitor, otherwise the
// window's.
type Hello struct {
	Width, Height        uint16
	Output               string
	Window, Class, Title string
}

func (h Hello) Marshal() []byte {
	b := []byte{TypeHello}
	b = le.AppendUint16(b, h.Width)
	b = le.AppendUint16(b, h.Height)
	b = append(b, shortString(h.Output)...)
	b = append(b, shortString(h.Window)...)
	b = append(b, shortString(h.Class)...)
	return append(b, shortString(h.Title)...)
}

// WindowInfo is one of the host's windows.
type WindowInfo struct {
	ID                 string // Hyprland's stableId
	Class, Title       string
	Workspace, Monitor string
	Focused            bool
}

// MarshalWindows lists the host's windows: u8 count, then per window str id,
// str class, str title, str workspace, str monitor, u8 flags (1 focused).
func MarshalWindows(ws []WindowInfo) []byte {
	if len(ws) > 255 {
		ws = ws[:255]
	}
	b := []byte{TypeWindows, byte(len(ws))}
	for _, w := range ws {
		for _, s := range []string{w.ID, w.Class, w.Title, w.Workspace, w.Monitor} {
			b = append(b, shortString(s)...)
		}
		var flags byte
		if w.Focused {
			flags |= 1
		}
		b = append(b, flags)
	}
	return b
}

// MarshalHostClipboard carries the host's clipboard text.
func MarshalHostClipboard(text string) []byte {
	b := []byte{TypeHostClipboard}
	b = le.AppendUint32(b, uint32(len(text)))
	return append(b, text...)
}

// CursorImage carries the host cursor bitmap. Width = Height = 0 means the host
// cursor has no capturable image and the viewer should show its default cursor.
type CursorImage struct {
	Width, Height, HotX, HotY uint16
	RGBA                      []byte
}

func (c CursorImage) Marshal() []byte {
	b := make([]byte, 9, 9+len(c.RGBA))
	b[0] = TypeCursorImage
	le.PutUint16(b[1:], c.Width)
	le.PutUint16(b[3:], c.Height)
	le.PutUint16(b[5:], c.HotX)
	le.PutUint16(b[7:], c.HotY)
	return append(b, c.RGBA...)
}

type CursorPosition struct {
	Inside bool
	X, Y   uint16
}

func (c CursorPosition) Marshal() []byte {
	b := make([]byte, 6)
	b[0] = TypeCursorPosition
	if c.Inside {
		b[1] = 1
	}
	le.PutUint16(b[2:], c.X)
	le.PutUint16(b[4:], c.Y)
	return b
}

type OutputInfo struct {
	Name          string
	Width, Height uint16
	Active        bool
}

func MarshalOutputs(outs []OutputInfo) []byte {
	b := []byte{TypeOutputs, byte(len(outs))}
	for _, o := range outs {
		name := o.Name
		if len(name) > 255 {
			name = name[:255]
		}
		var active byte
		if o.Active {
			active = 1
		}
		b = append(b, active, byte(o.Width), byte(o.Width>>8), byte(o.Height), byte(o.Height>>8), byte(len(name)))
		b = append(b, name...)
	}
	return b
}

// Codec IDs on the wire.
const (
	CodecH264 = 0
	CodecH265 = 1
	CodecAV1  = 2
)

// ModeInfo reports what the host is actually sending.
type ModeInfo struct {
	Mode          Mode
	Codec         uint8
	Width, Height uint16
	BitrateKbps   uint32
}

func (m ModeInfo) Marshal() []byte {
	b := make([]byte, 11)
	b[0] = TypeModeInfo
	b[1] = byte(m.Mode)
	b[2] = m.Codec
	le.PutUint16(b[3:], m.Width)
	le.PutUint16(b[5:], m.Height)
	le.PutUint32(b[7:], m.BitrateKbps)
	return b
}

type EndReason uint8

const (
	EndTakenOver    EndReason = 1 // Detail: the device that took over
	EndHostShutdown EndReason = 2
	EndCaptureError EndReason = 3 // Detail: error message
)

type SessionEnded struct {
	Reason EndReason
	Detail string
}

func (e SessionEnded) Marshal() []byte {
	return append([]byte{TypeSessionEnded, byte(e.Reason)}, shortString(e.Detail)...)
}

// PeerInfo tells the viewer how the host sees it.
type PeerInfo struct {
	Relayed bool
	Relay   string // DERP region when relayed
	Device  string // viewer's tailnet device name
}

func (p PeerInfo) Marshal() []byte {
	b := []byte{TypePeerInfo, 0}
	if p.Relayed {
		b[1] = 1
	}
	b = append(b, shortString(p.Relay)...)
	return append(b, shortString(p.Device)...)
}

// WorkspaceInfo is one of the host's workspaces.
type WorkspaceInfo struct {
	ID      int32
	Windows uint16
	// Active: shown on its monitor. Focused: its monitor has focus.
	Active, Focused bool
	Monitor, Name   string
}

// MarshalWorkspaces lists the host's regular workspaces: u8 count, then per
// workspace i32 id, u16 windows, u8 flags (1 active, 2 focused), str monitor,
// str name. Sent whenever they change.
func MarshalWorkspaces(ws []WorkspaceInfo) []byte {
	if len(ws) > 255 {
		ws = ws[:255]
	}
	b := []byte{TypeWorkspaces, byte(len(ws))}
	for _, w := range ws {
		var flags byte
		if w.Active {
			flags |= 1
		}
		if w.Focused {
			flags |= 2
		}
		b = le.AppendUint32(b, uint32(w.ID))
		b = le.AppendUint16(b, w.Windows)
		b = append(b, flags)
		b = append(b, shortString(w.Monitor)...)
		b = append(b, shortString(w.Name)...)
	}
	return b
}

// shortString is a u8 length followed by at most 255 bytes, cut at a UTF-8
// character boundary.
func shortString(s string) []byte {
	if len(s) > 255 {
		s = s[:255]
		for len(s) > 0 && !utf8.ValidString(s) {
			s = s[:len(s)-1]
		}
	}
	return append([]byte{byte(len(s))}, s...)
}

type Pong struct {
	Seq      uint32
	ClientMs float64
	HostUs   uint32 // microseconds the host spent between receipt and reply
}

func (p Pong) Marshal() []byte {
	b := make([]byte, 17)
	b[0] = TypePong
	le.PutUint32(b[1:], p.Seq)
	le.PutUint64(b[5:], math.Float64bits(p.ClientMs))
	le.PutUint32(b[13:], p.HostUs)
	return b
}

// Newer reports whether a is after b in uint16 sequence space.
func Newer(a, b uint16) bool {
	return a != b && uint16(a-b) < 0x8000
}
