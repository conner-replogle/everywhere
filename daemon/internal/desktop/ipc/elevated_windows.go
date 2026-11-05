package ipc

import (
	"os"
	"path/filepath"
)

// ElevatedSocket is the Unix socket an elevated worker connects to, in the
// user's own state directory (the daemon's, see service.LogPath). The daemon
// listens on it only while it starts one.
func ElevatedSocket() string {
	dir := os.Getenv("LOCALAPPDATA")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, "AppData", "Local")
	}
	return filepath.Join(dir, "everywhere", "desktop.sock")
}
