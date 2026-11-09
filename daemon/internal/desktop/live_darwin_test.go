package desktop

import (
	"bytes"
	"os"
	"testing"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
)

// TestMacLive streams the Mac's desktop through a real EverywhereDesktop.app
// and drives it like an agent. The app needs Screen Recording and
// Accessibility (`everywhere desktop enable`, or its `setup` mode).
//
//	macos/build.sh dev bin
//	EW_DESKTOP_LIVE=1 EVERYWHERE_DESKTOP_HELPER=$PWD/bin/EverywhereDesktop.app go test ./internal/desktop -run MacLive -v
func TestMacLive(t *testing.T) {
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
		t.Logf("window %s %q %q at %v size %v monitor %d hidden %v", w.Address, w.Class, w.Title, w.At, w.Size, w.Monitor, w.Hidden)
	}
	t.Logf("active window %q", h.activeWindow())

	for _, codec := range []ipc.Codec{ipc.H264, ipc.H265} {
		t.Run("stream "+codec.String(), func(t *testing.T) {
			encW, encH := scaledSize(mon.Width, mon.Height, 1080)
			w, err := startWorker(ipc.Config{Output: mon.Name, BitrateKbps: 8000, TargetUsage: 4, Codec: codec, Width: encW, Height: encH, Input: true}, h.env())
			if err != nil {
				t.Fatal(err)
			}
			defer w.Free()
			width, height := w.Size()
			t.Logf("worker: %s %dx%d (encoding %dx%d) input error %q", w.OutputName(), width, height, encW, encH, w.InputError())
			var frames, size int
			keyframe, params := false, false
			var dump bytes.Buffer // EW_DESKTOP_DUMP=path saves the stream, to check it decodes
			defer func() {
				if p := os.Getenv("EW_DESKTOP_DUMP"); p != "" {
					_ = os.WriteFile(p+"."+codec.String(), dump.Bytes(), 0o644)
				}
			}()
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) && (frames < 10 || !keyframe) {
				f, err := w.Next(100 * time.Millisecond)
				if err != nil {
					t.Fatal(err)
				}
				if f == nil {
					// An idle screen sends nothing; a keyframe request re-encodes the last frame.
					w.RequestKeyframe()
					continue
				}
				frames++
				size += len(f.Data)
				dump.Write(f.Data)
				if f.Keyframe {
					keyframe = true
					// H.264 SPS (type 7, any nal_ref_idc: VideoToolbox writes 0x27), HEVC VPS (0x40).
					params = params || bytes.Contains(f.Data, []byte{0, 0, 1, 0x40})
					for i := 0; !params && i+3 < len(f.Data); i++ {
						params = f.Data[i] == 0 && f.Data[i+1] == 0 && f.Data[i+2] == 1 && f.Data[i+3]&0x9f == 0x07
					}
				}
			}
			t.Logf("%d frames, %d bytes, keyframe %v with parameter sets %v", frames, size, keyframe, params)
			if frames == 0 || !keyframe || !params {
				t.Fatal("no stream")
			}
			w.SetBitrate(2000) // must not break it
			w.Motion(32768, 32768)
			cur, err := w.WaitCursor(nil, 2*time.Second)
			if cur == nil {
				t.Fatalf("no cursor update, err %v", err)
			}
			t.Logf("cursor at %d,%d inside %v, %dx%d image (%d bytes)", cur.X, cur.Y, cur.Inside, cur.Width, cur.Height, len(cur.RGBA))
			// The pointer went to the middle of the display, in points.
			if wantX, wantY := mon.Width/2/int(mon.Scale), mon.Height/2/int(mon.Scale); w.InputError() == "" &&
				(cur.X < wantX-3 || cur.X > wantX+3 || cur.Y < wantY-3 || cur.Y > wantY+3) {
				t.Errorf("pointer at %d,%d; want about %d,%d", cur.X, cur.Y, wantX, wantY)
			}
		})
	}

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
		d, err := a.List()
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("list: %d monitors, %d windows", len(d.Monitors), len(d.Windows))
		for _, win := range wins {
			if win.Hidden {
				continue // minimized or in another Space
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
