//go:build linux && cgo

package capture

/*
#cgo pkg-config: wayland-client gbm libdrm gstreamer-1.0 gstreamer-app-1.0 gstreamer-video-1.0 gstreamer-allocators-1.0
#cgo CFLAGS: -O2 -Wall -Wno-unused-parameter
#include <stdlib.h>
#include "capture.h"
*/
import "C"

import (
	"errors"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
)

type Frame struct {
	Data       []byte
	CapturedAt time.Duration // CLOCK_MONOTONIC
	Keyframe   bool
}

type Output struct {
	Name          string
	Width, Height int
}

type Capture struct {
	c *C.oc_capture
}

var ErrClosed = errors.New("capture closed")

func Start(cfg ipc.Config) (*Capture, error) {
	if cfg.TargetUsage == 0 {
		cfg.TargetUsage = 4
	}
	out := C.CString(cfg.Output)
	defer C.free(unsafe.Pointer(out))
	window := C.CString(cfg.Window)
	defer C.free(unsafe.Pointer(window))
	ccfg := C.oc_config{
		output:       out,
		window:       window,
		bitrate_kbps: C.int(cfg.BitrateKbps),
		target_usage: C.int(cfg.TargetUsage),
		codec:        C.int(cfg.Codec), // ipc.Codec values are the C OC_CODEC_* values
		width:        C.int(cfg.Width),
		height:       C.int(cfg.Height),
		max_fps:      C.int(cfg.MaxFPS),
	}
	if cfg.PaintCursor {
		ccfg.paint_cursor = 1
	}
	var errbuf [512]C.char
	c := C.oc_capture_start(&ccfg, &errbuf[0], C.size_t(len(errbuf)))
	if c == nil {
		return nil, errors.New(C.GoString(&errbuf[0]))
	}
	return &Capture{c: c}, nil
}

// Next blocks up to timeout for an encoded frame. It returns (nil, nil) on timeout.
func (c *Capture) Next(timeout time.Duration) (*Frame, error) {
	var s C.oc_sample
	switch C.oc_capture_pull(c.c, C.int(timeout.Milliseconds()), &s) {
	case 1:
		f := &Frame{
			Data:       C.GoBytes(unsafe.Pointer(s.data), C.int(s.len)),
			CapturedAt: time.Duration(s.capture_us) * time.Microsecond,
			Keyframe:   s.keyframe != 0,
		}
		C.oc_sample_free(&s)
		return f, nil
	case 0:
		return nil, nil
	}
	if msg := C.GoString(C.oc_capture_error(c.c)); msg != "" {
		return nil, errors.New(msg)
	}
	return nil, ErrClosed
}

func (c *Capture) RequestKeyframe()    { C.oc_capture_request_keyframe(c.c) }
func (c *Capture) SetBitrate(kbps int) { C.oc_capture_set_bitrate(c.c, C.int(kbps)) }
func (c *Capture) Close()              { C.oc_capture_close(c.c) }
func (c *Capture) Free()               { C.oc_capture_free(c.c) }
func (c *Capture) Size() (int, int) {
	return int(C.oc_capture_width(c.c)), int(C.oc_capture_height(c.c))
}
func (c *Capture) OutputName() string { return C.GoString(C.oc_capture_output(c.c)) }

func ListOutputs() ([]Output, error) {
	var errbuf [512]C.char
	raw := C.oc_list_outputs(&errbuf[0], C.size_t(len(errbuf)))
	if raw == nil {
		return nil, errors.New(C.GoString(&errbuf[0]))
	}
	defer C.free(unsafe.Pointer(raw))
	var outs []Output
	for _, line := range strings.Split(strings.TrimSpace(C.GoString(raw)), "\n") {
		f := strings.Split(line, "\t")
		if len(f) != 3 {
			continue
		}
		w, _ := strconv.Atoi(f[1])
		h, _ := strconv.Atoi(f[2])
		outs = append(outs, Output{Name: f[0], Width: w, Height: h})
	}
	return outs, nil
}

type Cursor struct {
	ImageGen, PosGen uint64
	Inside           bool
	X, Y             int // hotspot position in output pixels
	HotX, HotY       int
	Width, Height    int
	RGBA             []byte // non-nil only when the image changed
}

// WaitCursor blocks until the cursor differs from prev (generations), the
// timeout passes (nil, nil), or the capture closes (ErrClosed). It requires
// PaintCursor to be false.
func (c *Capture) WaitCursor(prev *Cursor, timeout time.Duration) (*Cursor, error) {
	var imgGen, posGen C.uint64_t
	if prev != nil {
		imgGen, posGen = C.uint64_t(prev.ImageGen), C.uint64_t(prev.PosGen)
	}
	var out C.oc_cursor
	switch C.oc_capture_cursor_wait(c.c, imgGen, posGen, C.int(timeout.Milliseconds()), &out) {
	case 0:
		return nil, nil
	case -1:
		return nil, ErrClosed
	}
	cur := &Cursor{
		ImageGen: uint64(out.img_gen), PosGen: uint64(out.pos_gen), Inside: out.inside != 0,
		X: int(out.x), Y: int(out.y), HotX: int(out.hot_x), HotY: int(out.hot_y),
		Width: int(out.width), Height: int(out.height),
	}
	if out.rgba != nil {
		cur.RGBA = C.GoBytes(unsafe.Pointer(out.rgba), out.width*out.height*4)
		C.free(unsafe.Pointer(out.rgba))
	}
	return cur, nil
}
