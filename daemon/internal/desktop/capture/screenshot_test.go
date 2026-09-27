//go:build linux && cgo

package capture

import (
	"image/png"
	"os"
	"testing"
)

// TestScreenshotLive copies a frame of the running desktop. It needs a
// Wayland session with ext-image-copy-capture:
//
//	EW_DESKTOP_LIVE=1 go test ./internal/desktop/capture -run Screenshot -v
//
// EW_DESKTOP_OUTPUT or EW_DESKTOP_WINDOW (a stableId) picks what to capture;
// EW_DESKTOP_PNG saves the result there.
func TestScreenshotLive(t *testing.T) {
	if os.Getenv("EW_DESKTOP_LIVE") == "" {
		t.Skip("EW_DESKTOP_LIVE not set")
	}
	img, err := Screenshot(os.Getenv("EW_DESKTOP_OUTPUT"), os.Getenv("EW_DESKTOP_WINDOW"))
	if err != nil {
		t.Fatal(err)
	}
	b := img.Bounds()
	t.Logf("%dx%d", b.Dx(), b.Dy())
	lit := 0
	for i := 0; i < len(img.Pix); i += 4 {
		if img.Pix[i]|img.Pix[i+1]|img.Pix[i+2] != 0 {
			lit++
		}
	}
	if lit == 0 {
		t.Fatal("the screenshot is all black")
	}
	if path := os.Getenv("EW_DESKTOP_PNG"); path != "" {
		f, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if err := png.Encode(f, img); err != nil {
			t.Fatal(err)
		}
	}
}
