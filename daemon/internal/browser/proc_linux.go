package browser

import "syscall"

// sysProcAttr kills the browser if the daemon dies without closing it.
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}
