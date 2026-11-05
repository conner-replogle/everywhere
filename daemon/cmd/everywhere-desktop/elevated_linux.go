//go:build linux && cgo

package main

import "os"

// serveElevated is Windows-only.
func serveElevated() int {
	os.Stderr.WriteString("everywhere-desktop: elevated workers are Windows-only\n")
	return 2
}

func elevated() bool { return false }
