//go:build unix

package desktop

import "syscall"

// alive reports whether process pid exists.
func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }
