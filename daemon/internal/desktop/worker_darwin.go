package desktop

import (
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
)

// On macOS the worker is EverywhereDesktop.app (daemon/macos), so that Screen
// Recording and Accessibility are granted to it rather than to the daemon:
// macOS asks about, and remembers, the process that LaunchServices started,
// not one the daemon forks. So the daemon starts it with `open -n`, which
// can't pass pipes, and the app connects back to a Unix socket in a private
// directory instead, then speaks the same protocol over it.

// launchWorker starts a worker in the app.
func launchWorker(app string, cfgJSON []byte, _ []string, _ bool) (workerProcess, io.WriteCloser, io.ReadCloser, error) {
	c, err := launchHelper(app, ipc.WorkerArg, string(cfgJSON))
	if err != nil {
		return nil, nil, nil, err
	}
	p := &connProcess{c: c, done: make(chan struct{})}
	return p, connWriter{p}, connReader{p}, nil
}

// launchHelper starts the app in mode (worker or host) and returns its
// connection.
func launchHelper(app, mode string, args ...string) (*net.UnixConn, error) {
	dir, err := os.MkdirTemp("", "everywhere-desktop-") // 0700
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "s")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		return nil, err
	}
	defer ln.Close()

	argv := append([]string{"-n", "-g", "-a", app, "--args", mode, sock}, args...)
	if out, err := exec.Command("open", argv...).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("starting %s: %w %s", filepath.Base(app), err, strings.TrimSpace(string(out)))
	}
	_ = ln.SetDeadline(time.Now().Add(15 * time.Second))
	c, err := ln.AcceptUnix()
	if err != nil {
		return nil, fmt.Errorf("%s didn't start: %w", filepath.Base(app), err)
	}
	return c, nil
}
