package desktop

import (
	"bytes"
	"image"
	"image/jpeg"
	"os"
	"slices"
	"testing"
	"time"
)

func TestParseCombo(t *testing.T) {
	for combo, want := range map[string][]uint32{
		"ctrl+shift+t": {29, 42, 20},
		"Enter":        {28},
		"super+1":      {125, 2},
		"alt + tab":    {56, 15},
		"f12":          {88},
		"f13":          {183},
		"ctrl+/":       {29, 53},
		"+":            {42, 13},
	} {
		got, err := parseCombo(combo)
		if err != nil || !slices.Equal(got, want) {
			t.Errorf("parseCombo(%q) = %v, %v; want %v", combo, got, err, want)
		}
	}
	for _, bad := range []string{"", "ctrl+", "hyper+x"} {
		if _, err := parseCombo(bad); err == nil {
			t.Errorf("parseCombo(%q) should fail", bad)
		}
	}
}

func TestFit(t *testing.T) {
	for _, c := range []struct{ w, h, ww, wh int }{
		{2560, 1440, 1280, 720},
		{1440, 2560, 720, 1280},
		{800, 600, 800, 600},
		{2536, 1390, 1280, 702},
	} {
		if w, h := fit(c.w, c.h, 1280); w != c.ww || h != c.wh {
			t.Errorf("fit(%d, %d) = %d×%d; want %d×%d", c.w, c.h, w, h, c.ww, c.wh)
		}
	}
}

func TestViewPointer(t *testing.T) {
	mon := deskMonitor{Name: "DP-1", X: 1000, Y: 0, Width: 2560, Height: 1440, Scale: 2}
	// A monitor: the point's share of the screenshot is its share of the monitor.
	v := &View{mon: mon, Width: 1280, Height: 720}
	px, py, lx, ly, err := v.pointer(Point{640, 360})
	if err != nil || px < 32700 || px > 32850 || py < 32700 || py > 32850 {
		t.Errorf("monitor centre -> %d, %d, %v", px, py, err)
	}
	if lx < 1639 || lx > 1641 || ly < 359 || ly > 361 { // 1280×720 logical at x=1000
		t.Errorf("monitor centre in layout = %g, %g", lx, ly)
	}
	if _, _, _, _, err := v.pointer(Point{1280, 0}); err == nil {
		t.Error("a point outside the screenshot should fail")
	}

	// A window at logical (1320, 180), 640×360 on that monitor, which is 1280×720 logical.
	c := &deskWindow{Address: "0x1", At: [2]int{1320, 180}, Size: [2]int{640, 360}}
	v = &View{mon: mon, win: newWindowGeom(c, mon), Width: 1280, Height: 720}
	px, py, lx, ly, err = v.pointer(Point{0, 0})
	if err != nil {
		t.Fatal(err)
	}
	// Its corner is a quarter of the way across the monitor and down.
	if px < 16370 || px > 16420 || py < 16370 || py > 16420 {
		t.Errorf("window corner -> %d, %d", px, py)
	}
	if lx < 1320 || lx > 1321 || ly < 180 || ly > 181 {
		t.Errorf("window corner in layout = %g, %g", lx, ly)
	}
}

func TestShrink(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 4, 2))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+3] = 200, 255
	}
	img.Pix[0] = 0 // one dark pixel in the first 2×2 block
	out := shrink(img, 2, 1)
	if out.Rect.Dx() != 2 || out.Rect.Dy() != 1 || out.Pix[0] != 150 || out.Pix[4] != 200 {
		t.Errorf("shrink = %v", out.Pix)
	}
}

// TestAgentLive screenshots the running desktop through an agent worker:
//
//	go build -o bin/everywhere-desktop ./cmd/everywhere-desktop
//	EW_DESKTOP_LIVE=1 EVERYWHERE_DESKTOP_HELPER=$PWD/bin/everywhere-desktop go test ./internal/desktop -run AgentLive -v
//
// EW_DESKTOP_WINDOW=<stableId> screenshots that window instead of the
// focused monitor; EW_DESKTOP=claude looks at Claude's desktop instead of
// yours. It only looks: no input.
func TestAgentLive(t *testing.T) {
	if os.Getenv("EW_DESKTOP_LIVE") == "" {
		t.Skip("EW_DESKTOP_LIVE not set")
	}
	m := &Manager{Enabled: func() bool { return true }}
	defer m.Shutdown()
	a, err := m.Agent("test")
	if err != nil {
		t.Fatal(err)
	}
	desk := os.Getenv("EW_DESKTOP")
	if desk == "" {
		desk = deskYours
	}
	if _, err := a.Open(desk, os.Getenv("EW_DESKTOP_WINDOW"), ""); err != nil {
		t.Fatal(err)
	}
	d, err := a.List()
	if err != nil || len(d.Monitors) == 0 {
		t.Fatalf("List = %+v, %v", d, err)
	}
	for range 2 { // the second reuses the worker
		shot, err := a.Screenshot(false)
		if err != nil {
			t.Fatal(err)
		}
		img, err := jpeg.Decode(bytes.NewReader(shot.JPEG))
		if err != nil {
			t.Fatal(err)
		}
		if b := img.Bounds(); b.Dx() != shot.View.Width || b.Dy() != shot.View.Height {
			t.Errorf("screenshot is %v; the view says %d×%d", b, shot.View.Width, shot.View.Height)
		}
		t.Logf("%+v: %d×%d, %d bytes", shot.View.Target, shot.View.Width, shot.View.Height, len(shot.JPEG))
	}
}

// TestAgentInputLive types into a terminal through an agent worker and
// checks what the terminal received. It moves the real pointer and switches
// to the window's workspace, so it runs only when asked:
//
//	foot -T ew-input-test sh -c 'cat > /tmp/typed.txt'   # on a spare workspace
//	EW_DESKTOP_LIVE=1 EW_DESKTOP_INPUT_WINDOW=<its stableId> EW_DESKTOP_INPUT_FILE=/tmp/typed.txt \
//	  EVERYWHERE_DESKTOP_HELPER=$PWD/bin/everywhere-desktop go test ./internal/desktop -run AgentInputLive -v
func TestAgentInputLive(t *testing.T) {
	win, file := os.Getenv("EW_DESKTOP_INPUT_WINDOW"), os.Getenv("EW_DESKTOP_INPUT_FILE")
	if os.Getenv("EW_DESKTOP_LIVE") == "" || win == "" || file == "" {
		t.Skip("EW_DESKTOP_LIVE, EW_DESKTOP_INPUT_WINDOW and EW_DESKTOP_INPUT_FILE not set")
	}
	m := &Manager{Enabled: func() bool { return true }}
	defer m.Shutdown()
	a, err := m.Agent("test")
	if err != nil {
		t.Fatal(err)
	}
	v, err := a.Open(deskYours, win, "")
	if err != nil {
		t.Fatal(err)
	}
	centre := Point{float64(v.Width) / 2, float64(v.Height) / 2}
	if err := a.Click(centre, "", 1); err != nil {
		t.Fatal(err)
	}
	if err := a.Scroll(centre, 0, 1); err != nil {
		t.Fatal(err)
	}
	const text = "Hello, World! 123 @#$%^&*() ~/{}[]|\\\"' <>?:+_-=`\n"
	if n, err := a.Type(text); err != nil || n != len([]rune(text)) {
		t.Fatalf("Type = %d, %v", n, err)
	}
	if err := a.Press("ctrl+d", 1); err != nil {
		t.Fatal(err)
	}
	var got []byte
	for range 20 {
		time.Sleep(100 * time.Millisecond)
		if got, _ = os.ReadFile(file); string(got) == text {
			return
		}
	}
	t.Errorf("the terminal got %q; want %q", got, text)
}
