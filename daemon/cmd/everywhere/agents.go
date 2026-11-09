package main

import (
	"errors"
	"fmt"

	"github.com/conner-replogle/everywhere/daemon/internal/config"
)

// agentsCmd turns connected agents' access to this device on or off. The
// app can too (over WebRTC); the server can't.
func agentsCmd(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: everywhere agents enable|disable|status")
	}
	switch args[0] {
	case "enable":
		if err := config.SetAgents(true); err != nil {
			return err
		}
		fmt.Println("Connected agents can now reach this device: the outside AI apps you connected under")
		fmt.Println("Settings → Connected agents, for the devices you picked when you connected each.")
		fmt.Println("They can read this device's threads and send them prompts, with files. Whoever runs")
		fmt.Println("that app sees what it reads, and text in a thread or web page can steer it.")
		fmt.Println("They can't run commands, read files outside threads, or answer permission prompts.")
	case "disable":
		if err := config.SetAgents(false); err != nil {
			return err
		}
		fmt.Println("Connected agents can't reach this device any more.")
	case "status":
		if config.AgentsEnabled() {
			fmt.Println("Connected agents: on")
		} else {
			fmt.Println("Connected agents: off (turn them on with `everywhere agents enable`)")
		}
	default:
		return errors.New("usage: everywhere agents enable|disable|status")
	}
	return nil
}
