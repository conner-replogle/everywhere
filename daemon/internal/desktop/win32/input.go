//go:build windows

package win32

import (
	"fmt"
	"math"
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

// MoveTo puts the pointer at a virtual-screen pixel.
func MoveTo(x, y float64) error {
	vs := VirtualScreen()
	norm := func(v float64, lo int32, extent int) int32 {
		if extent <= 1 {
			return 0
		}
		return int32(math.Round((v - float64(lo)) * 65535 / float64(extent-1)))
	}
	in := mouse(mouseMove|mouseAbsolute|mouseVirtualDesk, 0)
	in.Mi.Dx, in.Mi.Dy = norm(x, vs.Left, vs.Width()), norm(y, vs.Top, vs.Height())
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

// Wheel scrolls by notches (fractions allowed): dy down, dx right.
func Wheel(dx, dy float64) error {
	var ins []input
	if dy != 0 {
		ins = append(ins, mouse(mouseWheel, uint32(int32(math.Round(-dy*wheelDelta)))))
	}
	if dx != 0 {
		ins = append(ins, mouse(mouseHWheel, uint32(int32(math.Round(dx*wheelDelta)))))
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
