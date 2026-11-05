//go:build !windows

package desktop

import "errors"

// The elevated worker is Windows-only (elevated_windows.go).

const ElevateArg = "elevate"

var ErrDeclined = errors.New("administrator rights weren't granted")

func ElevatedInstalled() bool               { return false }
func ElevatedStatus() string                { return "" }
func SetupElevated(daemonExe string) error  { return nil }
func RemoveElevated(daemonExe string) error { return nil }
func ElevateMain(args []string) error       { return errors.New("elevated workers are Windows-only") }
