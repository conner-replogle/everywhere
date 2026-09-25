package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/conner-replogle/everywhere/daemon/internal/config"
	"github.com/conner-replogle/everywhere/daemon/internal/update"
	"github.com/conner-replogle/everywhere/daemon/internal/version"
)

// desktopCmd turns remote desktop on or off. It only works on the device
// itself, so neither a stolen web session nor the server can switch it on.
func desktopCmd(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: everywhere desktop enable|disable|status")
	}
	switch args[0] {
	case "enable":
		if runtime.GOOS != "linux" {
			return errors.New("remote desktop is only supported on Linux (Hyprland) for now")
		}
		if err := config.SetDesktop(true); err != nil {
			return err
		}
		if err := ensureWorker(); err != nil {
			return err
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
		} else {
			fmt.Println("Remote desktop: off (turn it on with `everywhere desktop enable`)")
		}
	default:
		return errors.New("usage: everywhere desktop enable|disable|status")
	}
	return nil
}

// ensureWorker installs the remote desktop worker for this release if it
// isn't next to the daemon: an update from a release before it didn't know
// to install it.
func ensureWorker() error {
	exe, err := executable()
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(exe), update.WorkerName)); err == nil {
		return nil
	}
	if !update.Newer(version.Version, "0") {
		return fmt.Errorf("%s isn't next to %s; build it (see README) for this development build", update.WorkerName, exe)
	}
	fmt.Printf("Installing %s %s...\n", update.WorkerName, version.Version)
	if err := update.InstallWorker(exe, version.Version); err != nil {
		return fmt.Errorf("installing %s: %w", update.WorkerName, err)
	}
	return nil
}
