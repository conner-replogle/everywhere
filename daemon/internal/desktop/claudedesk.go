package desktop

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Claude's desktop is a second Hyprland nested in the user's, whose one
// monitor is a headless output nobody sees but through a viewer. Its seat has
// its own pointer, keyboard focus and clipboard, so an agent working there
// leaves the user's alone: the user keeps working while Claude does.
//
// It's a Wayland client of the user's Hyprland, which lends it a GPU
// allocator (a headless-only Hyprland has none). Its own Wayland output, a
// window in the user's session, is disabled in its config, so that window
// never maps. It has no seat of its own (libseat is pointed at nothing), so it
// never touches the GPU's outputs or the real mouse and keyboard.

const (
	claudeOutput = "CLAUDE-1"
	claudeMode   = "1920x1080@60"
	// How long Claude's desktop gets to come up.
	claudeStartTimeout = 10 * time.Second
)

// errClaudeDesktop wraps why Claude's desktop can't run.
var errClaudeDesktop = errors.New("Claude's desktop can't start")

// errNoClaudeDesktop means this platform has no Claude's desktop.
var errNoClaudeDesktop = errors.New(`there's no Claude's desktop on this computer; use the user's desktop ("yours")`)

type claudeDesktop struct {
	mu     sync.Mutex
	h      *hyprInstance
	pid    int
	exited chan struct{} // closes when the Hyprland this daemon started exits; nil when adopted
}

func claudeConfigPath() string {
	return filepath.Join(runtimeDir(), "everywhere", "claude-desktop.lua")
}

// isClaudeDesktop reports whether Hyprland process pid is Claude's desktop,
// by the config it was started with (it may be an earlier daemon's).
func isClaudeDesktop(pid int) bool {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return false
	}
	return slices.Contains(strings.Split(string(b), "\x00"), claudeConfigPath())
}

// instance returns Claude's desktop, starting it in the user's session if it
// isn't running.
func (d *claudeDesktop) instance() (desktopHost, error) {
	h, err := d.hyprland()
	if err != nil {
		return nil, err
	}
	return h, nil
}

func (d *claudeDesktop) hyprland() (*hyprInstance, error) {
	if defaultDesk == deskYours {
		return nil, errNoClaudeDesktop
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.h != nil && alive(d.pid) {
		if _, err := os.Stat(filepath.Join(d.h.Dir, ".socket.sock")); err == nil {
			return d.h, nil
		}
	}
	d.h, d.pid, d.exited = nil, 0, nil
	for _, c := range hyprInstances() {
		if c.inst.Claude {
			d.h, d.pid = c.inst, c.pid
			return d.h, nil
		}
	}
	parent, err := findHyprland()
	if err != nil {
		return nil, err
	}
	if err := d.start(parent); err != nil {
		return nil, fmt.Errorf("%w: %v", errClaudeDesktop, err)
	}
	return d.h, nil
}

// start runs Claude's desktop inside parent. Must hold d.mu.
func (d *claudeDesktop) start(parent *hyprInstance) error {
	path := claudeConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(claudeConfig(parent.keymapValues())), 0o600); err != nil {
		return err
	}
	cmd := exec.Command("Hyprland", "--config", path)
	cmd.Env = claudeEnv(parent)
	if err := cmd.Start(); err != nil {
		return err
	}
	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(exited)
	}()
	pid := cmd.Process.Pid
	fail := func(err error) error {
		stopProcess(pid, exited)
		return err
	}

	var h *hyprInstance
	for deadline := time.Now().Add(claudeStartTimeout); h == nil; {
		select {
		case <-exited:
			return errors.New("Hyprland exited while starting (Claude's desktop needs Hyprland 0.56 or newer)")
		case <-time.After(100 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			return fail(errors.New("Hyprland didn't come up"))
		}
		for _, c := range hyprInstances() {
			if c.pid == pid {
				h = c.inst
			}
		}
	}
	h.lua.Store(true) // the config is Lua
	if out, err := h.request("output create headless " + claudeOutput); err != nil || strings.TrimSpace(string(out)) != "ok" {
		return fail(fmt.Errorf("adding its monitor: %s%v", out, err))
	}
	for deadline := time.Now().Add(claudeStartTimeout); ; {
		mons, err := h.monitors()
		if _, ok := resolveOutput(claudeOutput, mons); err == nil && ok {
			break
		}
		if time.Now().After(deadline) {
			return fail(errors.New("its monitor didn't appear"))
		}
		time.Sleep(50 * time.Millisecond)
	}
	d.h, d.pid, d.exited = h, pid, exited
	return nil
}

// stop ends Claude's desktop and the apps in it.
func (d *claudeDesktop) stop() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.pid != 0 {
		stopProcess(d.pid, d.exited)
	}
	if d.exited != nil {
		// Hyprland leaves its instance directory (logs) behind.
		_ = os.RemoveAll(d.h.Dir)
	}
	d.h, d.pid, d.exited = nil, 0, nil
}

// stopProcess asks pid to exit, then kills it. exited, if not nil, closes
// when it has.
func stopProcess(pid int, exited <-chan struct{}) {
	p, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	_ = p.Signal(syscall.SIGTERM)
	if exited == nil {
		return
	}
	select {
	case <-exited:
	case <-time.After(3 * time.Second):
		_ = p.Kill()
	}
}

// claudeEnv is the environment of Claude's desktop: a Wayland client of
// parent, with no seat, that leaves the session's environment alone.
func claudeEnv(parent *hyprInstance) []string {
	var env []string
	for _, kv := range parent.env() {
		switch k, _, _ := strings.Cut(kv, "="); k {
		case "HYPRLAND_INSTANCE_SIGNATURE", "DISPLAY", "LIBSEAT_BACKEND", "SEATD_SOCK", "AQ_DRM_DEVICES":
		default:
			env = append(env, kv)
		}
	}
	return append(env,
		// No seat: no DRM outputs, no real input devices.
		"LIBSEAT_BACKEND=seatd", "SEATD_SOCK=/nonexistent", "AQ_DRM_DEVICES=/nonexistent",
		// Don't point systemd and D-Bus activation at this Hyprland.
		"HYPRLAND_NO_SD_VARS=1", "HYPRLAND_NO_SD_NOTIFY=1", "HYPRLAND_NO_CRASHREPORTER=1",
	)
}

// claudeConfig is Claude's desktop's Hyprland config: one headless monitor,
// the user's keyboard layout, no animations, and nothing drawn over the apps.
func claudeConfig(kb map[string]string) string {
	var input strings.Builder
	for _, k := range []string{"kb_rules", "kb_model", "kb_layout", "kb_variant", "kb_options"} {
		if v := kb[k]; v != "" {
			fmt.Fprintf(&input, "    %s = %s,\n", k, luaString(v))
		}
	}
	return fmt.Sprintf(`-- Claude's desktop, written by the everywhere daemon.
hl.monitor({ output = %[1]s, mode = %[2]s, position = "0x0", scale = 1 })
-- The window it would have in your session.
hl.monitor({ output = "WAYLAND-1", disabled = true })
hl.config({
  input = {
%[3]s  },
  -- Screenshots follow actions at once: show windows where they end up.
  animations = { enabled = false },
  misc = {
    disable_hyprland_logo = true,
    disable_splash_rendering = true,
    disable_watchdog_warning = true,
  },
})
`, luaString(claudeOutput), luaString(claudeMode), input.String())
}

// luaString quotes s as a Lua string literal, dropping control characters.
func luaString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '\\' || r == '"':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r < 0x20 || r == 0x7f:
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

func execCmd(command string) dispatcher {
	return dispatcher{"exec " + command, "hl.dsp.exec_cmd(" + luaString(command) + ")"}
}
