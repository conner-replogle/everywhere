package desktop

import (
	"bytes"
	"os"
	"testing"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
	"github.com/conner-replogle/everywhere/daemon/internal/desktop/win32"
)

// TestWindowsLive streams the signed-in Windows desktop through a real
// everywhere-desktop.exe and drives it like an agent. It must run in the
// user's session (not over SSH, which is session 0), e.g. from a scheduled
// task:
//
//	set EW_DESKTOP_LIVE=1
//	set EVERYWHERE_DESKTOP_HELPER=C:\path\everywhere-desktop.exe
//	desktop.test.exe -test.run WindowsLive -test.v
func TestWindowsLive(t *testing.T) {
	if os.Getenv("EW_DESKTOP_LIVE") == "" {
		t.Skip("EW_DESKTOP_LIVE not set")
	}
	h, err := findDesktop()
	if err != nil {
		t.Fatal(err)
	}
	mons, err := h.monitors()
	if err != nil {
		t.Fatal(err)
	}
	mon, ok := resolveOutput("", mons)
	if !ok {
		t.Fatalf("no monitor in %+v", mons)
	}
	t.Logf("monitors %+v", mons)
	wins, err := h.clients()
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range wins {
		t.Logf("window %s %q %q at %v size %v monitor %d", w.Address, w.Class, w.Title, w.At, w.Size, w.Monitor)
	}

	t.Run("stream", func(t *testing.T) {
		encW, encH := scaledSize(mon.Width, mon.Height, 720)
		w, err := startWorker(ipc.Config{Output: mon.Name, BitrateKbps: 6000, TargetUsage: 4, Codec: ipc.H264, Width: encW, Height: encH, Input: true}, h.env())
		if err != nil {
			t.Fatal(err)
		}
		defer w.Free()
		width, height := w.Size()
		t.Logf("worker: %s %dx%d (encoding %dx%d) input error %q", w.OutputName(), width, height, encW, encH, w.InputError())
		w.RequestKeyframe()
		var frames, size int
		keyframe, sps := false, false
		var dump bytes.Buffer // EW_DESKTOP_DUMP=path saves the stream, to check it decodes
		defer func() {
			if p := os.Getenv("EW_DESKTOP_DUMP"); p != "" {
				_ = os.WriteFile(p, dump.Bytes(), 0o644)
			}
		}()
		var first, last time.Duration
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) && (frames < 90 || !keyframe) {
			f, err := w.Next(100 * time.Millisecond)
			if err != nil {
				t.Fatal(err)
			}
			if f == nil {
				w.RequestKeyframe()
				continue
			}
			if frames == 0 {
				first = f.CapturedAt
			}
			last = f.CapturedAt
			frames++
			size += len(f.Data)
			dump.Write(f.Data)
			if f.Keyframe {
				keyframe = true
				sps = sps || bytes.Contains(f.Data, []byte{0, 0, 1, 0x67}) || bytes.Contains(f.Data, []byte{0, 0, 1, 0x27})
			}
		}
		t.Logf("%d frames, %d bytes, keyframe %v with SPS %v, %v of capture time", frames, size, keyframe, sps, last-first)
		if frames == 0 || !keyframe || !sps {
			t.Fatal("no stream")
		}
		w.SetBitrate(2000) // must not break it
		w.Motion(32768, 32768)
		if f, err := w.Next(time.Second); err != nil {
			t.Fatal(err)
		} else if f == nil {
			w.RequestKeyframe()
		}
		cur, err := w.WaitCursor(nil, 2*time.Second)
		if cur != nil {
			t.Logf("cursor at %d,%d inside %v, %dx%d image (%d bytes)", cur.X, cur.Y, cur.Inside, cur.Width, cur.Height, len(cur.RGBA))
		} else {
			t.Logf("no cursor update, err %v", err)
		}
	})

	t.Run("agent", func(t *testing.T) {
		m := &Manager{ArtifactsDir: t.TempDir()}
		a, err := m.Agent("t1")
		if err != nil {
			t.Fatal(err)
		}
		defer m.CloseAgent("t1")
		v, err := a.Open("", "", "")
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("target %+v, %dx%d", v.Target, v.Width, v.Height)
		shot, err := a.Screenshot(true)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("screenshot %d bytes, saved %s", len(shot.JPEG), shot.Path)
		if err := a.Move(Point{float64(v.Width) / 2, float64(v.Height) / 2}); err != nil {
			t.Fatal(err)
		}
		x, y := win32.CursorPos()
		wantX, wantY := mon.X+mon.Width/2, mon.Y+mon.Height/2
		t.Logf("pointer at %d,%d; want about %d,%d", x, y, wantX, wantY)
		if abs(int(x)-wantX) > 3 || abs(int(y)-wantY) > 3 {
			t.Errorf("pointer at %d,%d; want %d,%d", x, y, wantX, wantY)
		}
		d, err := a.List()
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("list: %d monitors, %d windows", len(d.Monitors), len(d.Windows))
		for _, win := range wins {
			if win.Hidden {
				continue // minimized: nothing to capture
			}
			sv, err := a.Open("", win.StableID, "")
			if err != nil {
				t.Fatal(err)
			}
			ws, err := a.Screenshot(false)
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("window target %+v: %dx%d screenshot, %d bytes", sv.Target, sv.Width, sv.Height, len(ws.JPEG))
			break
		}

		before, _ := a.Clipboard()
		if err := a.SetClipboard("everywhere ✓ clipboard"); err != nil {
			t.Fatal(err)
		}
		if got, err := a.Clipboard(); err != nil || got != "everywhere ✓ clipboard" {
			t.Errorf("clipboard = %q, %v", got, err)
		}
		_ = a.SetClipboard(before)
	})
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
