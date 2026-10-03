// Package service installs the daemon as a background service: a systemd
// unit on Linux, a launchd job on macOS, a scheduled task on Windows.
package service

import (
	"errors"
	"os"
)

// ErrNoServiceManager means this machine has no service manager we support.
var ErrNoServiceManager = errors.New("no supported service manager was found")

func isRoot() bool { return os.Geteuid() == 0 }
