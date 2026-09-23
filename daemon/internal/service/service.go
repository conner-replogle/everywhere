// Package service installs the daemon as a systemd unit: a user unit (with
// lingering) for normal users, or a system unit when run as root.
package service

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
)

const unitName = "everywhere.service"

// ExitRevoked is the daemon's exit status when its device was removed; the
// unit doesn't restart on it.
const ExitRevoked = 3

var ErrNoSystemd = errors.New("systemd was not found")

func isRoot() bool { return os.Geteuid() == 0 }

func HasSystemd() bool {
	_, err := os.Stat("/run/systemd/system")
	return err == nil
}

func unitPath() string {
	if isRoot() {
		return filepath.Join("/etc/systemd/system", unitName)
	}
	cfg, _ := os.UserConfigDir()
	return filepath.Join(cfg, "systemd", "user", unitName)
}

func systemctl(args ...string) *exec.Cmd {
	if !isRoot() {
		args = append([]string{"--user"}, args...)
	}
	cmd := exec.Command("systemctl", args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd
}

func unit(bin string) string {
	var b strings.Builder
	fmt.Fprintf(&b, `[Unit]
Description=everywhere daemon
Wants=network-online.target
After=network-online.target

[Service]
ExecStart=%s daemon
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=%d
`, bin, ExitRevoked)
	if isRoot() {
		b.WriteString("User=root\n\n[Install]\nWantedBy=multi-user.target\n")
	} else {
		b.WriteString("\n[Install]\nWantedBy=default.target\n")
	}
	return b.String()
}

// Install writes the unit for the binary at bin, enables and (re)starts it.
func Install(bin string) error {
	if !HasSystemd() {
		return ErrNoSystemd
	}
	path := unitPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(unit(bin)), 0o644); err != nil {
		return err
	}
	if !isRoot() {
		// Keep the user's services running after they log out.
		if u, err := user.Current(); err == nil {
			if err := exec.Command("loginctl", "enable-linger", u.Username).Run(); err != nil {
				fmt.Fprintf(os.Stderr, "warning: `loginctl enable-linger %s` failed; the daemon will stop when you log out\n", u.Username)
			}
		}
	}
	if err := systemctl("daemon-reload").Run(); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %w", err)
	}
	if err := systemctl("enable", unitName).Run(); err != nil {
		return fmt.Errorf("systemctl enable: %w", err)
	}
	return Restart()
}

// Restart restarts the unit if it is installed.
func Restart() error {
	if !Installed() {
		return nil
	}
	if err := systemctl("restart", unitName).Run(); err != nil {
		return fmt.Errorf("systemctl restart: %w", err)
	}
	return nil
}

func Installed() bool {
	_, err := os.Stat(unitPath())
	return err == nil
}

// Uninstall stops, disables and removes the unit.
func Uninstall() error {
	if !Installed() {
		return nil
	}
	_ = systemctl("disable", "--now", unitName).Run()
	if err := os.Remove(unitPath()); err != nil {
		return err
	}
	return systemctl("daemon-reload").Run()
}

// Status returns systemd's active state for the unit, e.g. "active".
func Status() string {
	if !Installed() {
		return "not installed"
	}
	args := []string{"is-active", unitName}
	if !isRoot() {
		args = append([]string{"--user"}, args...)
	}
	out, _ := exec.Command("systemctl", args...).Output()
	return strings.TrimSpace(string(out))
}
