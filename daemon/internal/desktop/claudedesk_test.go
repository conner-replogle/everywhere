package desktop

import (
	"fmt"
	"math"
	"os"
	"strings"
	"testing"
	"time"
)

func TestLuaString(t *testing.T) {
	for in, want := range map[string]string{
		`foot`:                  `"foot"`,
		`sh -c "echo \"hi\""`:   `"sh -c \"echo \\\"hi\\\"\""`,
		"a\nb\x00c\td":          `"abcd"`,
		`C:\path`:               `"C:\\path"`,
		"déjà vu":               `"déjà vu"`,
		`]] os.execute("x") --`: `"]] os.execute(\"x\") --"`,
	} {
		if got := luaString(in); got != want {
			t.Errorf("luaString(%q) = %s; want %s", in, got, want)
		}
	}
}

func TestClaudeConfig(t *testing.T) {
	c := claudeConfig(map[string]string{"kb_layout": "us,de", "kb_options": `compose:caps`})
	for _, want := range []string{
		`hl.monitor({ output = "CLAUDE-1", mode = "1920x1080@60"`,
		`hl.monitor({ output = "WAYLAND-1", disabled = true })`,
		`kb_layout = "us,de",`,
		`kb_options = "compose:caps",`,
		`disable_watchdog_warning = true`,
	} {
		if !strings.Contains(c, want) {
			t.Errorf("config lacks %q:\n%s", want, c)
		}
	}
	if strings.Contains(c, "kb_variant") {
		t.Errorf("config sets an empty option:\n%s", c)
	}
}

// TestClaudeDesktopLive starts Claude's desktop in the logged-in Hyprland
// session, launches a terminal there, clicks and types in it, and checks the
// text arrived and the user's pointer never moved. Run it on the desktop machine:
//
//	EW_DESKTOP_LIVE=1 EVERYWHERE_DESKTOP_HELPER=$PWD/bin/everywhere-desktop go test ./internal/desktop -run ClaudeDesktopLive -v
func TestClaudeDesktopLive(t *testing.T) {
	if os.Getenv("EW_DESKTOP_LIVE") == "" {
		t.Skip("EW_DESKTOP_LIVE not set")
	}
	user, err := findHyprland()
	if err != nil {
		t.Fatal(err)
	}
	cursor := func(h *hyprInstance) string {
		out, err := h.request("cursorpos")
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(out))
	}
	m := &Manager{Enabled: func() bool { return true }}
	defer m.Shutdown()
	a, err := m.Agent("test")
	if err != nil {
		t.Fatal(err)
	}
	file := t.TempDir() + "/typed.txt"
	start := time.Now()
	win, err := a.Launch("foot sh -c 'cat > " + file + "'")
	if err != nil {
		t.Fatal(err)
	}
	if win == nil {
		t.Fatal("no window appeared")
	}
	t.Logf("launched %+v in %v", *win, time.Since(start))
	if h, err := findHyprland(); err != nil || h.Signature != user.Signature {
		t.Fatalf("findHyprland = %v, %v; want the user's %s", h, err, user.Signature)
	}
	v, err := a.Current()
	if err != nil {
		t.Fatal(err)
	}
	if v.Target.Desktop != deskClaude || v.Target.Monitor != claudeOutput {
		t.Fatalf("target = %+v", v.Target)
	}
	// The click lands at the centre of Claude's monitor, and only there.
	before := cursor(user)
	if err := a.Click(Point{float64(v.Width) / 2, float64(v.Height) / 2}, "", 1); err != nil {
		t.Fatal(err)
	}
	// Injected input would jump it; a hand on the mouse only nudges it.
	if after := cursor(user); cursorDistance(before, after) > 20 {
		t.Errorf("the user's pointer jumped during the click: %s -> %s", before, after)
	}
	if got := cursor(v.h); got != "960, 540" {
		t.Errorf("Claude's pointer is at %s; want 960, 540", got)
	}
	const text = "Hello from Claude's desktop! ~/{}[]|\\\"'\n"
	if n, err := a.Type(text); err != nil || n != len([]rune(text)) {
		t.Fatalf("Type = %d, %v", n, err)
	}
	shot, err := a.Screenshot(false)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("screenshot %d×%d, %d bytes", shot.View.Width, shot.View.Height, len(shot.JPEG))
	if os.Getenv("EW_DESKTOP_SHOT") != "" {
		_ = os.WriteFile(os.Getenv("EW_DESKTOP_SHOT"), shot.JPEG, 0o600)
	}
	if err := a.Press("ctrl+d", 1); err != nil {
		t.Fatal(err)
	}
	var got []byte
	for range 20 {
		time.Sleep(100 * time.Millisecond)
		if got, _ = os.ReadFile(file); string(got) == text {
			break
		}
	}
	if string(got) != text {
		t.Errorf("typed %q; want %q", got, text)
	}
}

// cursorDistance is how far apart two of hyprctl's "x, y" cursor positions are.
func cursorDistance(a, b string) float64 {
	var ax, ay, bx, by float64
	if _, err := fmt.Sscanf(a, "%g, %g", &ax, &ay); err != nil {
		return math.Inf(1)
	}
	if _, err := fmt.Sscanf(b, "%g, %g", &bx, &by); err != nil {
		return math.Inf(1)
	}
	return math.Hypot(ax-bx, ay-by)
}
