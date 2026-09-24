//go:build !linux

package browser

import "syscall"

func sysProcAttr() *syscall.SysProcAttr { return nil }
