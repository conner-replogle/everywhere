//go:build !(linux && cgo) && !windows

// Command everywhere-desktop is the daemon's remote desktop worker. It needs
// Windows, or Linux with cgo (Wayland, libgbm, GStreamer); this build is
// neither.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "everywhere-desktop: remote desktop needs Windows, or a Linux build with cgo")
	os.Exit(1)
}
