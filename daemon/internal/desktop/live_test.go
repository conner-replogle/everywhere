package desktop

import (
	"os"
	"testing"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
)

// TestLive captures the running Hyprland session through a real
// everywhere-desktop worker (built into ../../bin) and checks that encoded
// frames and a keyframe arrive. It needs a desktop session and a VA-API GPU.
//
//	go build -o bin/everywhere-desktop ./cmd/everywhere-desktop
//	EW_DESKTOP_LIVE=1 EVERYWHERE_DESKTOP_HELPER=$PWD/bin/everywhere-desktop go test ./internal/desktop -run Live -v
func TestLive(t *testing.T) {
	if os.Getenv("EW_DESKTOP_LIVE") == "" {
		t.Skip("EW_DESKTOP_LIVE not set")
	}
	h, err := findHyprland()
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
	km := h.keymap()
	t.Logf("hyprland %s on %s; monitor %s %dx%d@%.2f; keymap %+v", h.Signature, h.Wayland, mon.Name, mon.Width, mon.Height, mon.Scale, km)

	// EW_DESKTOP_WINDOW=<stableId> captures that window instead.
	w, err := startWorker(ipc.Config{Output: mon.Name, Window: os.Getenv("EW_DESKTOP_WINDOW"), BitrateKbps: 8000, TargetUsage: 4, Codec: ipc.H264, Input: true, Keymap: km}, h.env())
	if err != nil {
		t.Fatal(err)
	}
	defer w.Free()
	width, height := w.Size()
	t.Logf("worker: %s %dx%d input error %q", w.OutputName(), width, height, w.InputError())

	w.RequestKeyframe()
	var frames, bytes int
	keyframe := false
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && (frames < 5 || !keyframe) {
		f, err := w.Next(100 * time.Millisecond)
		if err != nil {
			t.Fatal(err)
		}
		if f == nil {
			// An idle screen sends nothing; nudge it with a keyframe request.
			w.RequestKeyframe()
			continue
		}
		frames++
		bytes += len(f.Data)
		keyframe = keyframe || f.Keyframe
	}
	t.Logf("%d frames, %d bytes, keyframe %v", frames, bytes, keyframe)
	if frames == 0 || !keyframe {
		t.Fatal("no keyframe from the encoder")
	}
}

// TestLiveDispatch focuses the monitor that already has focus (a no-op) in
// whichever syntax this Hyprland takes (Lua config or hyprlang).
//
//	EW_DESKTOP_LIVE=1 go test ./internal/desktop -run LiveDispatch -v
func TestLiveDispatch(t *testing.T) {
	if os.Getenv("EW_DESKTOP_LIVE") == "" {
		t.Skip("EW_DESKTOP_LIVE not set")
	}
	h, err := findHyprland()
	if err != nil {
		t.Fatal(err)
	}
	mons, err := h.monitors()
	if err != nil {
		t.Fatal(err)
	}
	if err := h.dispatch(focusMonitor(focusedOutput(mons))); err != nil {
		t.Fatal(err)
	}
	t.Logf("lua dispatch: %v", h.lua.Load())
	if err := h.dispatch(focusMonitor(focusedOutput(mons))); err != nil {
		t.Fatal(err)
	}
}
