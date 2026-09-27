// Package proc runs a command together with everything it starts, so the
// whole tree can be signalled at once: a process group on Unix, a job object
// on Windows.
package proc

import "os/exec"

// Start starts cmd as the root of a new Group.
func Start(cmd *exec.Cmd) (*Group, error) {
	isolate(cmd)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return Attach(cmd)
}
