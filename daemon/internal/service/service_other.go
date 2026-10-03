//go:build !linux && !darwin && !windows

package service

const ExitRevoked = 3

func Install(bin string) error { return ErrNoServiceManager }
func Restart() error           { return nil }
func Installed() bool          { return false }
func Uninstall() error         { return nil }
func Status() string           { return "not supported" }
