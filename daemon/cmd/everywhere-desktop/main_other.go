//go:build !linux || !cgo

// Command everywhere-desktop is the daemon's remote desktop worker. It needs
// Linux and cgo (Wayland, libgbm, GStreamer); this build has neither.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "everywhere-desktop: remote desktop needs a Linux build with cgo")
	os.Exit(1)
}
