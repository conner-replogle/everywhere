//go:build unix

package claude

import "golang.org/x/sys/unix"

// writable reports whether the user may write in dir.
func writable(dir string) bool { return unix.Access(dir, unix.W_OK) == nil }
