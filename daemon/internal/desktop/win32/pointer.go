//go:build windows

package win32

import (
	"fmt"
	"unsafe"
)

var procSystemParametersInfo = user32.NewProc("SystemParametersInfoW")

// mouseKeys is MOUSEKEYS.
type mouseKeys struct {
	Size, Flags                         uint32
	MaxSpeed, TimeToMaxSpeed, CtrlSpeed uint32
	Reserved1, Reserved2                uint32
}

const (
	spiGetMouseKeys = 0x0036
	spiSetMouseKeys = 0x0037
	mkfMouseKeysOn  = 0x0001
	mkfAvailable    = 0x0002
)

func getMouseKeys() (mouseKeys, error) {
	mk := mouseKeys{}
	mk.Size = uint32(unsafe.Sizeof(mk))
	if r, _, err := procSystemParametersInfo.Call(spiGetMouseKeys, uintptr(mk.Size), uintptr(unsafe.Pointer(&mk)), 0); r == 0 {
		return mk, fmt.Errorf("SPI_GETMOUSEKEYS: %w", err)
	}
	return mk, nil
}

// setMouseKeys applies mk for this sign-in only: nothing is written to the
// profile, so it doesn't outlive a crash past the next sign-in.
func setMouseKeys(mk mouseKeys) error {
	mk.Size = uint32(unsafe.Sizeof(mk))
	if r, _, err := procSystemParametersInfo.Call(spiSetMouseKeys, uintptr(mk.Size), uintptr(unsafe.Pointer(&mk)), 0); r == 0 {
		return fmt.Errorf("SPI_SETMOUSEKEYS: %w", err)
	}
	return nil
}

// ShowPointer makes Windows draw the pointer when it hides it because no
// mouse is plugged in (input that programs inject doesn't count as one), by
// turning Mouse Keys on: Windows shows the pointer whenever it's on. It does
// nothing if the pointer is showing or Mouse Keys is already on. restore
// puts Mouse Keys back as it was, unless someone changed it since; it is nil
// when nothing changed.
func ShowPointer() (restore func(), err error) {
	if pointerDrawn() {
		return nil, nil
	}
	was, err := getMouseKeys()
	if err != nil {
		return nil, err
	}
	if was.Flags&mkfMouseKeysOn != 0 {
		return nil, nil
	}
	on := was
	on.Flags |= mkfMouseKeysOn | mkfAvailable
	if err := setMouseKeys(on); err != nil {
		return nil, err
	}
	return func() {
		if now, err := getMouseKeys(); err == nil && now.Flags == on.Flags {
			_ = setMouseKeys(was)
		}
	}, nil
}

// pointerDrawn reports whether Windows draws the pointer: not hidden by a
// program, nor left undrawn for want of a mouse (which may read as either
// not showing or suppressed).
func pointerDrawn() bool {
	ci := cursorInfo{}
	ci.Size = uint32(unsafe.Sizeof(ci))
	if r, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci))); r == 0 {
		return true // can't tell; leave Mouse Keys alone
	}
	return ci.Flags&cursorShowing != 0 && ci.Cursor != 0
}
