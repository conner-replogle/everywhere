package desktop

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"testing"
)

// fakeInstance makes a Hyprland instance directory as Hyprland does: a lock
// file with the compositor's PID and Wayland socket, and the IPC socket.
func fakeInstance(t *testing.T, runtime, sig string, pid int) {
	t.Helper()
	dir := filepath.Join(runtime, "hypr", sig)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "hyprland.lock"), fmt.Appendf(nil, "%d\nwayland-%s\n", pid, sig), 0o600); err != nil {
		t.Fatal(err)
	}
	l, err := net.Listen("unix", filepath.Join(dir, ".socket.sock"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
}

func TestFindHyprland(t *testing.T) {
	// Unix socket paths are short; t.TempDir() can be too long.
	rt, err := os.MkdirTemp("", "ewh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(rt) })
	t.Setenv("XDG_RUNTIME_DIR", rt)
	t.Setenv("HYPRLAND_INSTANCE_SIGNATURE", "")

	if _, err := findHyprland(); err != errNoSession {
		t.Fatalf("no instances: err = %v", err)
	}

	// A crashed session leaves its directory behind; its PID is gone.
	fakeInstance(t, rt, "dead", 1<<22+12345)
	if _, err := findHyprland(); err != errNoSession {
		t.Fatalf("dead instance: err = %v", err)
	}

	fakeInstance(t, rt, "live", os.Getpid())
	h, err := findHyprland()
	if err != nil {
		t.Fatal(err)
	}
	if h.Signature != "live" || h.Wayland != "wayland-live" {
		t.Fatalf("found %+v", h)
	}
	env := h.env()
	want := map[string]bool{"XDG_RUNTIME_DIR=" + rt: true, "WAYLAND_DISPLAY=wayland-live": true, "HYPRLAND_INSTANCE_SIGNATURE=live": true}
	for _, kv := range env {
		delete(want, kv)
	}
	if len(want) != 0 {
		t.Fatalf("env missing %v", want)
	}
}

func TestResolveOutput(t *testing.T) {
	mons := []hyprMonitor{{Name: "DP-4", Focused: true}, {Name: "eDP-1"}, {Name: "HDMI-A-1", Disabled: true}}
	if m, _ := resolveOutput("", mons); m.Name != "eDP-1" {
		t.Errorf(`"" = %s, want eDP-1`, m.Name)
	}
	if m, _ := resolveOutput("DP-4", mons); m.Name != "DP-4" {
		t.Errorf("DP-4 = %s", m.Name)
	}
	if _, ok := resolveOutput("HDMI-A-1", mons); ok {
		t.Error("disabled monitor resolved")
	}
	if f := focusedOutput(mons); f != "DP-4" {
		t.Errorf("focused = %s", f)
	}
}
