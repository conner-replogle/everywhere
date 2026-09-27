//go:build unix

package proc

import (
	"os/exec"
	"syscall"
)

// Group is a started command and the processes it starts.
type Group struct{ pid int }

func isolate(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// Attach makes a Group of a started cmd that already leads its own process
// group or session, e.g. one started on a PTY.
func Attach(cmd *exec.Cmd) (*Group, error) {
	return &Group{pid: cmd.Process.Pid}, nil
}

// Signal sends sig to every process in the group.
func (g *Group) Signal(sig syscall.Signal) error {
	return syscall.Kill(-g.pid, sig)
}

// Release frees what the Group holds once the command has exited.
func (g *Group) Release() {}
