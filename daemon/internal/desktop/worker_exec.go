//go:build !darwin

package desktop

import (
	"io"
	"os"
	"os/exec"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
)

// launchWorker starts everywhere-desktop as a child process, with its config
// in argv and the protocol on stdin and stdout.
func launchWorker(exe string, cfgJSON []byte, env []string) (workerProcess, io.WriteCloser, io.ReadCloser, error) {
	cmd := exec.Command(exe, ipc.WorkerArg, string(cfgJSON))
	cmd.Env = env
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, nil, err
	}
	// A plain pipe rather than StdoutPipe: Wait must not close it before the
	// final error message has been read.
	stdout, stdoutW, err := os.Pipe()
	if err != nil {
		return nil, nil, nil, err
	}
	cmd.Stdout = stdoutW
	err = cmd.Start()
	stdoutW.Close()
	if err != nil {
		stdout.Close()
		return nil, nil, nil, err
	}
	return childProcess{cmd}, stdin, stdout, nil
}

type childProcess struct{ cmd *exec.Cmd }

func (p childProcess) Wait() error { return p.cmd.Wait() }
func (p childProcess) Kill() error { return p.cmd.Process.Kill() }
