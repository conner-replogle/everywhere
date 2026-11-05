package main

import (
	"net"

	"golang.org/x/sys/windows"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
)

// serveElevated is a worker that Task Scheduler started as administrator:
// it connects to the daemon, which is listening for it, and reads its config
// there.
func serveElevated() int {
	c, err := net.Dial("unix", ipc.ElevatedSocket())
	if err != nil {
		return 1 // nobody to tell; the daemon times out and starts a plain worker
	}
	defer c.Close()
	cfg, err := ipc.ReadConfig(c)
	if err != nil {
		return 1
	}
	return serve(cfg, c, c, true)
}

// elevated reports whether this worker runs as administrator, so that its
// input reaches programs that do (Windows drops input sent up to them).
func elevated() bool { return windows.GetCurrentProcessToken().IsElevated() }
