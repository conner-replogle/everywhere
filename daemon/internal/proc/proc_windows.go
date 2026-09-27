package proc

import (
	"os/exec"
	"sync"
	"syscall"

	"golang.org/x/sys/windows"
)

// Group is a started command and the processes it starts. On Windows it's a
// job object: children join it on their own, and there are no signals, so
// Signal ends them all whatever sig is.
type Group struct {
	mu  sync.Mutex
	job windows.Handle
}

func isolate(cmd *exec.Cmd) {}

// Attach puts a started cmd in a new job object. Anything it starts before
// that stays outside the job; that's only its first instants.
func Attach(cmd *exec.Cmd) (*Group, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	p, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	defer windows.CloseHandle(p)
	if err := windows.AssignProcessToJobObject(job, p); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	return &Group{job: job}, nil
}

// Signal ends every process in the group.
func (g *Group) Signal(sig syscall.Signal) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.job == 0 {
		return nil
	}
	return windows.TerminateJobObject(g.job, 1)
}

// Release frees the job object once the command has exited. Processes still
// in it keep running, as a process group's would.
func (g *Group) Release() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.job != 0 {
		windows.CloseHandle(g.job)
		g.job = 0
	}
}
