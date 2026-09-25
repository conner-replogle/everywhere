// Package ipc is the pipe protocol between the daemon and its
// everywhere-desktop worker, which captures, encodes and injects input in the
// graphical session. The daemon stays CGO-free; the worker links Wayland,
// libgbm and GStreamer, and a GPU encoder crash only takes the worker down.
//
// The worker gets its Config as JSON in argv[2]. It writes framed messages to
// stdout: a type byte, a little-endian u32 length and the payload. It reads
// commands from stdin: a command byte and a fixed-size payload.
package ipc

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
)

// WorkerArg is the worker's argv[1].
const WorkerArg = "worker"

// Version is this protocol's revision. The worker reports it in Hello; a
// daemon refuses a worker from another revision (they ship together, so a
// mismatch means a half-finished install).
const Version = 2

// Worker → daemon message types.
const (
	MsgHello  = 'H' // JSON Hello; always the first message
	MsgFrame  = 'F' // u64 capture µs (CLOCK_MONOTONIC), u8 keyframe, encoded access unit
	MsgCursor = 'C' // see CursorHeaderLen
	MsgError  = 'E' // UTF-8 message; the worker exits after it
)

// Daemon → worker commands and their payloads.
const (
	CmdKeyframe   = 'K' // —
	CmdBitrate    = 'B' // u32 kbps
	CmdQuit       = 'Q' // —
	CmdMotion     = 'M' // u16 x, u16 y (0..65535 across the output)
	CmdButton     = 'P' // u32 linux BTN_* code, u8 pressed, u16 x, u16 y
	CmdScroll     = 'S' // u8 continuous, f64 dx, f64 dy
	CmdKey        = 'Y' // u32 linux KEY_* code, u8 pressed
	CmdReleaseAll = 'R' // —
)

// CommandLen is each command's payload size after the command byte.
var CommandLen = map[byte]int{
	CmdKeyframe: 0, CmdBitrate: 4, CmdQuit: 0, CmdMotion: 4, CmdButton: 9,
	CmdScroll: 17, CmdKey: 5, CmdReleaseAll: 0,
}

// CursorHeaderLen is the fixed part of a cursor message: u64 image generation,
// u64 position generation, u8 inside, then i32 x, y, hotX, hotY, width, height.
// RGBA pixels follow when the image changed.
const CursorHeaderLen = 41

type Codec int

const (
	H264 Codec = 0
	H265 Codec = 1
	AV1  Codec = 2
)

func (c Codec) String() string {
	switch c {
	case H264:
		return "H264"
	case H265:
		return "H265"
	case AV1:
		return "AV1"
	}
	return fmt.Sprintf("Codec(%d)", int(c))
}

// Keymap is the host's XKB rules/model/layout/variant/options, so the virtual
// keyboard types exactly like the physical one.
type Keymap struct {
	Rules, Model, Layout, Variant, Options string
}

type Config struct {
	// Output is the wl_output to capture ("" picks eDP-1, else the first
	// output), and the one the virtual pointer maps onto.
	Output string
	// Window, if set, captures this window (Hyprland's stableId, which is its
	// ext-foreign-toplevel identifier) instead of Output.
	Window      string
	BitrateKbps int
	PaintCursor bool
	TargetUsage int // VA target-usage: 1 (quality) .. 7 (speed)
	Codec       Codec
	// Width and Height scale the encoded video; zero keeps the native size.
	Width, Height int
	// MaxFPS caps the capture rate; zero follows content changes.
	MaxFPS int
	// Input opens a virtual pointer (mapped onto Output) and keyboard.
	Input  bool
	Keymap Keymap
}

type Hello struct {
	Version       int
	Width, Height int
	Output        string
	// InputError says why input isn't available; the session is view-only.
	InputError string `json:",omitempty"`
}

var LE = binary.LittleEndian

// MaxMessage bounds a message; encoded frames are far smaller.
const MaxMessage = 64 << 20

func ReadMsg(r *bufio.Reader) (byte, []byte, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := LE.Uint32(hdr[1:])
	if n > MaxMessage {
		return 0, nil, fmt.Errorf("message too large (%d bytes)", n)
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	return hdr[0], payload, nil
}

// WriteMsg writes one message; the caller serializes writers and flushes.
func WriteMsg(w io.Writer, typ byte, parts ...[]byte) error {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	hdr := [5]byte{typ}
	LE.PutUint32(hdr[1:], uint32(n))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	for _, p := range parts {
		if _, err := w.Write(p); err != nil {
			return err
		}
	}
	return nil
}
