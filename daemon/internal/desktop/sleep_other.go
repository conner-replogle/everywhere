//go:build !windows

package desktop

import (
	"log/slog"
	"os/exec"
)

// inhibitSleep blocks system suspend until the returned func is called. Screen
// locking still works: injected input resets hypridle, and an idle remote
// viewer should lock (and can type the password).
func inhibitSleep(why string) func() {
	cmd := exec.Command("systemd-inhibit", "--what=sleep", "--who=everywhere", "--why="+why, "--mode=block", "sleep", "infinity")
	if err := cmd.Start(); err != nil {
		slog.Warn("cannot inhibit sleep", "err", err)
		return func() {}
	}
	go func() { _ = cmd.Wait() }()
	return func() { _ = cmd.Process.Kill() }
}
