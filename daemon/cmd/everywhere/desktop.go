package main

import (
	"errors"
	"fmt"
	"runtime"

	"github.com/conner-replogle/everywhere/daemon/internal/config"
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
