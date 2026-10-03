//go:build !windows

package main

import (
	"os"
	"syscall"
)

// reexec replaces this process with the binary on disk, keeping the PID so
// systemd (or whatever started us) sees one continuous run.
func reexec() error {
	exe, err := executable()
	if err != nil {
		return err
	}
	return syscall.Exec(exe, os.Args, os.Environ())
}

func removeSelf(exe string) error { return os.Remove(exe) }
