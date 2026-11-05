//go:build !darwin && !windows

package desktop

import "io"

func launchWorker(exe string, cfgJSON []byte, env []string, _ bool) (workerProcess, io.WriteCloser, io.ReadCloser, error) {
	return launchChild(exe, cfgJSON, env)
}
