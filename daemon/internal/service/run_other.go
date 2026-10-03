//go:build !windows

package service

import "errors"

// ExitRestart and SupervisedEnv are only used on Windows, where the service
// supervises the daemon itself.
const (
	ExitRestart   = 75
	SupervisedEnv = "EVERYWHERE_SUPERVISED"
)

// Run is the Windows service's supervisor; systemd and launchd supervise the
// daemon elsewhere.
func Run(bin string) error { return errors.New("`service run` is only used on Windows") }
