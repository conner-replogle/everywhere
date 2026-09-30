// On macOS the daemon is a launchd job: a LaunchAgent in the user's GUI
// session for normal users, or a LaunchDaemon when run as root.
package service

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

const label = "dev.replogle.everywhere"

// ExitRevoked is the daemon's exit status when its device was removed. launchd
// can't be told to skip one failing status, so it's a clean exit, which the
// job's KeepAlive doesn't restart.
const ExitRevoked = 0

func plistPath() string {
	if isRoot() {
		return filepath.Join("/Library/LaunchDaemons", label+".plist")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", label+".plist")
}

func logPath() string {
	if isRoot() {
		return "/var/log/everywhere.log"
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Logs", "everywhere.log")
}

// domain is the launchd domain the job lives in.
func domain() string {
	if isRoot() {
		return "system"
	}
	return fmt.Sprintf("gui/%d", os.Getuid())
}

func launchctl(args ...string) *exec.Cmd {
	cmd := exec.Command("launchctl", args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

func plist(bin string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>%s</string>
	<key>ProgramArguments</key>
	<array>
		<string>%s</string>
		<string>daemon</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>5</integer>
	<key>StandardOutPath</key>
	<string>%s</string>
	<key>StandardErrorPath</key>
	<string>%s</string>
</dict>
</plist>
`, label, xmlEscape(bin), xmlEscape(logPath()), xmlEscape(logPath()))
}

// Install writes the job for the binary at bin, loads and (re)starts it.
func Install(bin string) error {
	if _, err := exec.LookPath("launchctl"); err != nil {
		return ErrNoServiceManager
	}
	path := plistPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(logPath()), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(plist(bin)), 0o644); err != nil {
		return err
	}
	// Reload so a changed plist takes effect; bootout fails harmlessly when
	// the job isn't loaded.
	_ = exec.Command("launchctl", "bootout", domain()+"/"+label).Run()
	if err := launchctl("bootstrap", domain(), path).Run(); err != nil {
		return fmt.Errorf("launchctl bootstrap: %w", err)
	}
	return nil
}

// Restart restarts the job if it is installed.
func Restart() error {
	if !Installed() {
		return nil
	}
	if err := launchctl("kickstart", "-k", domain()+"/"+label).Run(); err != nil {
		return fmt.Errorf("launchctl kickstart: %w", err)
	}
	return nil
}

func Installed() bool {
	_, err := os.Stat(plistPath())
	return err == nil
}

// Uninstall stops, unloads and removes the job.
func Uninstall() error {
	if !Installed() {
		return nil
	}
	_ = exec.Command("launchctl", "bootout", domain()+"/"+label).Run()
	return os.Remove(plistPath())
}

var stateRE = regexp.MustCompile(`(?m)^\s*state = (\S+)`)

// Status returns launchd's state for the job, e.g. "running".
func Status() string {
	if !Installed() {
		return "not installed"
	}
	out, err := exec.Command("launchctl", "print", domain()+"/"+label).Output()
	if err != nil {
		return "not loaded"
	}
	if m := stateRE.FindSubmatch(out); m != nil {
		return string(m[1])
	}
	return "unknown"
}
