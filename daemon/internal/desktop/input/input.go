//go:build linux && cgo

package input

/*
#cgo pkg-config: wayland-client xkbcommon
#cgo CFLAGS: -O2 -Wall -Wno-unused-parameter
#include <stdlib.h>
#include "input.h"
*/
import "C"

import (
	"errors"
	"unsafe"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
)

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

type Device struct {
	d *C.oi_input
}

func Open(output string, km ipc.Keymap) (*Device, error) {
	strs := []*C.char{C.CString(output), C.CString(km.Rules), C.CString(km.Model), C.CString(km.Layout), C.CString(km.Variant), C.CString(km.Options)}
	defer func() {
		for _, s := range strs {
			C.free(unsafe.Pointer(s))
		}
	}()
	cfg := C.oi_config{output: strs[0], rules: strs[1], model: strs[2], layout: strs[3], variant: strs[4], options: strs[5]}
	var errbuf [256]C.char
	d := C.oi_open(&cfg, &errbuf[0], C.size_t(len(errbuf)))
	if d == nil {
		return nil, errors.New(C.GoString(&errbuf[0]))
	}
	return &Device{d: d}, nil
}

func check(r C.int) error {
	if r < 0 {
		return ErrBroken
	}
	return nil
}

func (d *Device) Motion(x, y uint16) error {
	return check(C.oi_motion(d.d, C.uint32_t(x), C.uint32_t(y)))
}

func (d *Device) Button(code uint32, pressed bool) error {
	return check(C.oi_button(d.d, C.uint32_t(code), cbool(pressed)))
}

// Scroll sends pixel deltas when continuous, otherwise wheel notches.
func (d *Device) Scroll(continuous bool, dx, dy float64) error {
	return check(C.oi_axis(d.d, cbool(continuous), C.double(dx), C.double(dy)))
}

func (d *Device) Key(code uint32, pressed bool) error {
	return check(C.oi_key(d.d, C.uint32_t(code), cbool(pressed)))
}

func (d *Device) ReleaseAll() error { return check(C.oi_release_all(d.d)) }

func (d *Device) Close() { C.oi_close(d.d) }

func cbool(b bool) C.int {
	if b {
		return 1
	}
	return 0
}
