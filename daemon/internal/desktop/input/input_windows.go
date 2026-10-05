package input

import (
	"errors"
	"sync"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
	"github.com/conner-replogle/everywhere/daemon/internal/desktop/win32"
)

// On Windows input goes through SendInput: the real pointer and keyboard
// focus, since Windows has one of each. Key codes are Linux evdev codes, as
// everywhere in remote desktop; their low range is exactly the PC's set-1
// scancodes, which SendInput takes, so the host's layout decides the
// character as it does for a physical key.

// Linux BTN_* codes.
const (
	BtnLeft   = 0x110
	BtnRight  = 0x111
	BtnMiddle = 0x112
	BtnSide   = 0x113
	BtnExtra  = 0x114
	MotionMax = 65535
)

var ErrBroken = errors.New("input connection lost")

// ErrNoKey is never returned on Windows: Type sends characters, not keys.
var ErrNoKey = errors.New("no key on this keyboard layout types it")

type Device struct {
	mon win32.Rect

	mu      sync.Mutex
	keys    map[uint32]bool
	buttons map[uint32]bool
}

// Open injects input on output (a display name like DISPLAY1; "" for the
// primary one). The keymap is the host's own.
func Open(output string, _ ipc.Keymap) (*Device, error) {
	m, err := win32.FindMonitor(output)
	if err != nil {
		return nil, err
	}
	return &Device{mon: m.Rect, keys: map[uint32]bool{}, buttons: map[uint32]bool{}}, nil
}

// Motion moves the pointer to x, y in 0..MotionMax across the output.
func (d *Device) Motion(x, y uint16) error {
	px := float64(d.mon.Left) + float64(x)/MotionMax*float64(d.mon.Width()-1)
	py := float64(d.mon.Top) + float64(y)/MotionMax*float64(d.mon.Height()-1)
	return win32.MoveTo(px, py)
}

var buttons = map[uint32]int{
	BtnLeft: win32.ButtonLeft, BtnRight: win32.ButtonRight, BtnMiddle: win32.ButtonMiddle,
	BtnSide: win32.ButtonBack, BtnExtra: win32.ButtonForward,
}

func (d *Device) Button(code uint32, pressed bool) error {
	b, ok := buttons[code]
	if !ok {
		return nil
	}
	d.mu.Lock()
	d.buttons[code] = pressed
	d.mu.Unlock()
	return win32.Button(b, pressed)
}

// pixelsPerNotch is how far browsers scroll per wheel notch, to turn a
// touchpad's pixels into wheel turns.
const pixelsPerNotch = 100

// Scroll turns the wheel: notches, or pixels when continuous.
func (d *Device) Scroll(continuous bool, dx, dy float64) error {
	if continuous {
		dx, dy = dx/pixelsPerNotch, dy/pixelsPerNotch
	}
	return win32.Wheel(dx, dy)
}

// Key presses or releases a key by its Linux KEY_* code.
func (d *Device) Key(code uint32, pressed bool) error {
	sc, vk, ok := winKey(code)
	if !ok {
		return nil // no such key on a PC keyboard
	}
	d.mu.Lock()
	d.keys[code] = pressed
	d.mu.Unlock()
	return win32.Key(sc, vk, pressed)
}

// Type types r, whatever the layout.
func (d *Device) Type(r rune) error { return win32.Type(r) }

// ReleaseAll releases every key and button this device pressed.
func (d *Device) ReleaseAll() error {
	d.mu.Lock()
	keys, btns := d.keys, d.buttons
	d.keys, d.buttons = map[uint32]bool{}, map[uint32]bool{}
	d.mu.Unlock()
	var errs []error
	for code, down := range keys {
		if sc, vk, ok := winKey(code); ok && down {
			errs = append(errs, win32.Key(sc, vk, false))
		}
	}
	for code, down := range btns {
		if down {
			errs = append(errs, win32.Button(buttons[code], false))
		}
	}
	return errors.Join(errs...)
}

func (d *Device) Close() {}

// Keys beyond the set-1 range that evdev numbers differently: 0xE0-prefixed
// scancodes, and keys Windows knows by virtual-key code.
var extended = map[uint32]uint16{
	96: 0xe01c, 97: 0xe01d, 98: 0xe035, 99: 0xe037, 100: 0xe038, // KPENTER RIGHTCTRL KPSLASH SYSRQ RIGHTALT
	102: 0xe047, 103: 0xe048, 104: 0xe049, 105: 0xe04b, 106: 0xe04d, // HOME UP PAGEUP LEFT RIGHT
	107: 0xe04f, 108: 0xe050, 109: 0xe051, 110: 0xe052, 111: 0xe053, // END DOWN PAGEDOWN INSERT DELETE
	125: 0xe05b, 126: 0xe05c, 127: 0xe05d, // LEFTMETA RIGHTMETA COMPOSE (menu)
	117: 0x59, // KPEQUAL
}

var virtualKeys = map[uint32]uint16{
	113: 0xad, 114: 0xae, 115: 0xaf, // MUTE VOLUMEDOWN VOLUMEUP
	119: 0x13,                                  // PAUSE
	163: 0xb0, 164: 0xb3, 165: 0xb1, 166: 0xb2, // NEXTSONG PLAYPAUSE PREVIOUSSONG STOPCD
}

// winKey maps a Linux KEY_* code to a set-1 scancode (0xE0xx when extended)
// or, failing that, a virtual-key code.
func winKey(code uint32) (scancode, vk uint16, ok bool) {
	switch {
	case code >= 1 && code <= 88: // ESC..F12, the numpad, 102ND: set-1 itself
		return uint16(code), 0, true
	case code >= 183 && code <= 194: // F13..F24
		return []uint16{0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x76}[code-183], 0, true
	}
	if sc, ok := extended[code]; ok {
		return sc, 0, true
	}
	if vk, ok := virtualKeys[code]; ok {
		return 0, vk, true
	}
	return 0, 0, false
}
