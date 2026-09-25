//go:build linux && cgo

// Command everywhere-desktop is the daemon's remote desktop worker: it
// captures and encodes one Hyprland output and injects the viewer's input. The
// daemon starts it per capture and talks to it over stdin/stdout (see
// internal/desktop/ipc); it is never run by hand.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"os"
	"sync"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/capture"
	"github.com/conner-replogle/everywhere/daemon/internal/desktop/input"
	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
	"github.com/conner-replogle/everywhere/daemon/internal/version"
)

var le = ipc.LE

func main() {
	if len(os.Args) < 2 || os.Args[1] != ipc.WorkerArg {
		if len(os.Args) > 1 && os.Args[1] == "version" {
			fmt.Println(version.Version)
			return
		}
		fmt.Fprintln(os.Stderr, "everywhere-desktop is started by the everywhere daemon for remote desktop sessions.")
		os.Exit(2)
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)).With("worker", os.Getpid()))

	out := bufio.NewWriterSize(os.Stdout, 1<<20)
	var outMu sync.Mutex
	write := func(typ byte, parts ...[]byte) error {
		outMu.Lock()
		defer outMu.Unlock()
		if err := ipc.WriteMsg(out, typ, parts...); err != nil {
			return err
		}
		return out.Flush()
	}

	var cfg ipc.Config
	if len(os.Args) < 3 || json.Unmarshal([]byte(os.Args[2]), &cfg) != nil {
		_ = write(ipc.MsgError, []byte("desktop worker: bad config"))
		os.Exit(2)
	}
	c, err := capture.Start(cfg)
	if err != nil {
		_ = write(ipc.MsgError, []byte(err.Error()))
		os.Exit(1)
	}
	w, h := c.Size()
	hello := ipc.Hello{Version: ipc.Version, Width: w, Height: h, Output: c.OutputName()}

	in := &injector{}
	if cfg.Input {
		dev, err := input.Open(c.OutputName(), cfg.Keymap)
		if err != nil {
			slog.Error("input unavailable; session is view-only", "err", err)
			hello.InputError = err.Error()
		} else {
			in.dev = dev
		}
	}
	helloJSON, _ := json.Marshal(hello)
	_ = write(ipc.MsgHello, helloJSON)

	go func() {
		r := bufio.NewReader(os.Stdin)
		for {
			cmd, err := r.ReadByte()
			if err != nil || cmd == ipc.CmdQuit {
				c.Close()
				return
			}
			n, ok := ipc.CommandLen[cmd]
			if !ok {
				slog.Error("unknown command", "cmd", cmd)
				c.Close()
				return
			}
			var buf [32]byte
			p := buf[:n]
			if _, err := io.ReadFull(r, p); err != nil {
				c.Close()
				return
			}
			switch cmd {
			case ipc.CmdKeyframe:
				c.RequestKeyframe()
			case ipc.CmdBitrate:
				c.SetBitrate(int(le.Uint32(p)))
			default:
				in.apply(cmd, p)
			}
		}
	}()

	var wg sync.WaitGroup
	if !cfg.PaintCursor {
		wg.Go(func() {
			var prev *capture.Cursor
			for {
				cur, err := c.WaitCursor(prev, time.Second)
				if err != nil {
					return
				}
				if cur == nil {
					continue
				}
				var p [ipc.CursorHeaderLen]byte
				le.PutUint64(p[0:], cur.ImageGen)
				le.PutUint64(p[8:], cur.PosGen)
				if cur.Inside {
					p[16] = 1
				}
				for i, v := range []int{cur.X, cur.Y, cur.HotX, cur.HotY, cur.Width, cur.Height} {
					le.PutUint32(p[17+4*i:], uint32(int32(v)))
				}
				if write(ipc.MsgCursor, p[:], cur.RGBA) != nil {
					c.Close()
					return
				}
				prev = cur
			}
		})
	}

	code := 0
	for {
		f, err := c.Next(100 * time.Millisecond)
		if err != nil {
			if !errors.Is(err, capture.ErrClosed) {
				_ = write(ipc.MsgError, []byte(err.Error()))
				code = 1
			}
			break
		}
		if f == nil {
			continue
		}
		var hdr [9]byte
		le.PutUint64(hdr[:], uint64(f.CapturedAt.Microseconds()))
		if f.Keyframe {
			hdr[8] = 1
		}
		if write(ipc.MsgFrame, hdr[:], f.Data) != nil {
			break
		}
	}
	c.Close()
	wg.Wait()
	in.close()
	c.Free()
	os.Exit(code)
}

// injector applies input commands to the virtual devices. After an injection
// error the devices are closed and input is ignored (view-only).
type injector struct {
	mu  sync.Mutex
	dev *input.Device
}

func (in *injector) apply(cmd byte, p []byte) {
	in.mu.Lock()
	defer in.mu.Unlock()
	if in.dev == nil {
		return
	}
	var err error
	switch cmd {
	case ipc.CmdMotion:
		err = in.dev.Motion(le.Uint16(p[0:]), le.Uint16(p[2:]))
	case ipc.CmdButton:
		if err = in.dev.Motion(le.Uint16(p[5:]), le.Uint16(p[7:])); err == nil {
			err = in.dev.Button(le.Uint32(p[0:]), p[4] != 0)
		}
	case ipc.CmdScroll:
		dx := math.Float64frombits(le.Uint64(p[1:]))
		dy := math.Float64frombits(le.Uint64(p[9:]))
		err = in.dev.Scroll(p[0] != 0, dx, dy)
	case ipc.CmdKey:
		err = in.dev.Key(le.Uint32(p[0:]), p[4] != 0)
	case ipc.CmdReleaseAll:
		err = in.dev.ReleaseAll()
	}
	if err != nil {
		slog.Error("input injection failed; session is now view-only", "err", err)
		in.dev.Close()
		in.dev = nil
	}
}

func (in *injector) close() {
	in.mu.Lock()
	defer in.mu.Unlock()
	if in.dev != nil {
		_ = in.dev.ReleaseAll()
		in.dev.Close()
		in.dev = nil
	}
}
