//go:build windows

package win32

import (
	"fmt"
	"unicode/utf16"
	"unsafe"
)

const (
	inputMouse    = 0
	inputKeyboard = 1

	mouseMove        = 0x0001
	mouseLeftDown    = 0x0002
	mouseLeftUp      = 0x0004
	mouseRightDown   = 0x0008
	mouseRightUp     = 0x0010
	mouseMiddleDown  = 0x0020
	mouseMiddleUp    = 0x0040
	mouseXDown       = 0x0080
	mouseXUp         = 0x0100
	mouseWheel       = 0x0800
	mouseHWheel      = 0x1000
	mouseVirtualDesk = 0x4000
	mouseAbsolute    = 0x8000

	keyExtended = 0x0001
	keyUp       = 0x0002
	keyUnicode  = 0x0004
	keyScancode = 0x0008

	wheelDelta = 120
)

type mouseInput struct {
	Dx, Dy    int32
	MouseData uint32
	Flags     uint32
	Time      uint32
	ExtraInfo uintptr
}

type keybdInput struct {
	Vk, Scan  uint16
	Flags     uint32
	Time      uint32
	ExtraInfo uintptr
}

// input is INPUT with its mouse member, the union's largest.
type input struct {
	Type uint32
	Mi   mouseInput
}

func (in *input) keyboard() *keybdInput { return (*keybdInput)(unsafe.Pointer(&in.Mi)) }

func send(ins ...input) error {
	if len(ins) == 0 {
		return nil
	}
	n, _, err := procSendInput.Call(uintptr(len(ins)), uintptr(unsafe.Pointer(&ins[0])), unsafe.Sizeof(ins[0]))
	if int(n) != len(ins) {
		return fmt.Errorf("SendInput: %w (another program may be blocking input, or a UAC prompt is up)", err)
	}
	return nil
}

func mouse(flags, data uint32) input {
	return input{Type: inputMouse, Mi: mouseInput{Flags: flags, MouseData: data}}
}

// MoveTo puts the pointer on a virtual-screen pixel.
func MoveTo(x, y int32) error {
	vs := VirtualScreen()
	in := mouse(mouseMove|mouseAbsolute|mouseVirtualDesk, 0)
	in.Mi.Dx, in.Mi.Dy = absolute(x, vs.Left, vs.Width()), absolute(y, vs.Top, vs.Height())
	return send(in)
}

// absolute is the 0..65535 coordinate that lands on pixel v of extent
// pixels from lo. Windows takes pixel = coordinate × extent / 65536, rounded
// down, so the coordinate is rounded up: rounding to nearest, as is usual,
// lands a pixel short on the left and top halves of the screen.
func absolute(v, lo int32, extent int) int32 {
	if extent <= 1 {
		return 0
	}
	p := int64(min(max(v-lo, 0), int32(extent-1)))
	return int32(min((p*65536+int64(extent)-1)/int64(extent), 65535))
}

// MoveBy moves the pointer by dx, dy pixels, as a mouse does: raw input
// sees the motion, which games that capture the pointer read.
func MoveBy(dx, dy int32) error {
	in := mouse(mouseMove, 0)
	in.Mi.Dx, in.Mi.Dy = dx, dy
	return send(in)
}

// Mouse buttons, as Button takes them.
const (
	ButtonLeft = iota
	ButtonRight
	ButtonMiddle
	ButtonBack
	ButtonForward
)

// Button presses or releases a mouse button where the pointer is.
func Button(b int, pressed bool) error {
	var down, up, data uint32
	switch b {
	case ButtonLeft:
		down, up = mouseLeftDown, mouseLeftUp
	case ButtonRight:
		down, up = mouseRightDown, mouseRightUp
	case ButtonMiddle:
		down, up = mouseMiddleDown, mouseMiddleUp
	case ButtonBack:
		down, up, data = mouseXDown, mouseXUp, 1
	case ButtonForward:
		down, up, data = mouseXDown, mouseXUp, 2
	default:
		return fmt.Errorf("unknown button %d", b)
	}
	if pressed {
		return send(mouse(down, data))
	}
	return send(mouse(up, data))
}

// WheelDelta is one wheel notch, in Wheel's units.
const WheelDelta = wheelDelta

// Wheel turns the wheel by dx, dy WheelDelta-ths of a notch (smooth-scrolling
// programs take fractions): dy down, dx right.
func Wheel(dx, dy int32) error {
	var ins []input
	if dy != 0 {
		ins = append(ins, mouse(mouseWheel, uint32(-dy)))
	}
	if dx != 0 {
		ins = append(ins, mouse(mouseHWheel, uint32(dx)))
	}
	return send(ins...)
}

// Key presses or releases a key by its set-1 scancode; extended keys
// (0xE0-prefixed) have 0xE000 set. A scancode of 0 sends vk instead.
func Key(scancode, vk uint16, pressed bool) error {
	in := input{Type: inputKeyboard}
	k := in.keyboard()
	if scancode != 0 {
		k.Scan, k.Flags = scancode&0xff, keyScancode
		if scancode&0xff00 == 0xe000 {
			k.Flags |= keyExtended
		}
	} else {
		k.Vk = vk
	}
	if !pressed {
		k.Flags |= keyUp
	}
	return send(in)
}

// Type types r as itself, whatever the keyboard layout.
func Type(r rune) error {
	var ins []input
	for _, u := range utf16.Encode([]rune{r}) {
		for _, flags := range []uint32{keyUnicode, keyUnicode | keyUp} {
			in := input{Type: inputKeyboard}
			k := in.keyboard()
			k.Scan, k.Flags = u, flags
			ins = append(ins, in)
		}
	}
	return send(ins...)
}
