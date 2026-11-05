package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/conner-replogle/everywhere/daemon/internal/config"
	"github.com/conner-replogle/everywhere/daemon/internal/desktop"
	"github.com/conner-replogle/everywhere/daemon/internal/update"
	"github.com/conner-replogle/everywhere/daemon/internal/version"
)

// desktopCmd turns remote desktop on or off. It only works on the device
// itself, so neither a stolen web session nor the server can switch it on.
func desktopCmd(args []string) error {
	if len(args) > 1 && args[0] == desktop.ElevateArg && runtime.GOOS == "windows" {
		// SetupElevated and RemoveElevated run this as administrator.
		return desktop.ElevateMain(args[1:])
	}
	if len(args) != 1 {
		return errors.New("usage: everywhere desktop enable|disable|status")
	}
	switch args[0] {
	case "enable":
		if runtime.GOOS != "linux" && runtime.GOOS != "windows" && runtime.GOOS != "darwin" {
			return errors.New("remote desktop is only supported on Linux (Hyprland), Windows and macOS")
		}
		if err := config.SetDesktop(true); err != nil {
			return err
		}
		if err := ensureWorker(); err != nil {
			return err
		}
		if runtime.GOOS == "darwin" {
			if err := macPermissions(); err != nil {
				return err
			}
		}
		if runtime.GOOS == "windows" {
			if err := windowsElevated(); err != nil {
				return err
			}
		}
		fmt.Println("Remote desktop is on. Open this device in the web app and choose Remote desktop.")
		fmt.Println("Anyone signed in to your account can then see and control this screen.")
	case "disable":
		if err := config.SetDesktop(false); err != nil {
			return err
		}
		fmt.Println("Remote desktop is off. Sessions that are open now keep running until they end.")
	case "status":
		if config.DesktopEnabled() {
			fmt.Println("Remote desktop: on")
			if st := desktop.ElevatedStatus(); st != "" {
				fmt.Println("Admin windows:", st)
			}
		} else {
			fmt.Println("Remote desktop: off (turn it on with `everywhere desktop enable`)")
		}
	default:
		return errors.New("usage: everywhere desktop enable|disable|status")
	}
	return nil
}

// ensureWorker installs the remote desktop worker for this release if it
// isn't next to the daemon (see update.EnsureWorker).
func ensureWorker() error {
	exe, err := executable()
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(exe), update.WorkerName)); err != nil && !update.Newer(version.Version, "0") {
		return fmt.Errorf("%s isn't next to %s; build it (see README) for this development build", update.WorkerName, exe)
	}
	installed, err := update.EnsureWorker(exe, version.Version)
	if err != nil {
		return fmt.Errorf("installing %s: %w", update.WorkerName, err)
	}
	if installed {
		fmt.Printf("Installed %s %s.\n", update.WorkerName, version.Version)
	}
	return nil
}

// windowsElevated sets up the elevated worker, whose input reaches games and
// programs running as administrator, after a UAC prompt. Declining it isn't
// an error: remote desktop works without it.
func windowsElevated() error {
	exe, err := executable()
	if err != nil {
		return err
	}
	fmt.Println("Windows asks for administrator rights next, so the mouse and keyboard also reach games")
	fmt.Println("and programs running as administrator.")
	switch err := desktop.SetupElevated(exe); {
	case errors.Is(err, desktop.ErrDeclined):
		fmt.Println("Skipped: the mouse and keyboard won't reach programs running as administrator.")
		fmt.Println("Run `everywhere desktop enable` again to set it up.")
	case err != nil:
		return fmt.Errorf("setting up input for programs running as administrator: %w", err)
	default:
		fmt.Println("The mouse and keyboard reach programs running as administrator too.")
	}
	return nil
}

// macPermissions has EverywhereDesktop.app ask for Screen Recording and
// Accessibility, which only someone at the Mac can grant.
func macPermissions() error {
	exe, err := executable()
	if err != nil {
		return err
	}
	app := filepath.Join(filepath.Dir(exe), update.WorkerName)
	if out, err := exec.Command("open", "-W", "-n", "-a", app, "--args", "setup").CombinedOutput(); err != nil {
		return fmt.Errorf("starting %s: %w %s", update.WorkerName, err, out)
	}
	fmt.Println("On this Mac, allow Everywhere Desktop in System Settings › Privacy & Security, under both")
	fmt.Println("Screen & System Audio Recording (to see the screen) and Accessibility (to control it).")
	return nil
}
