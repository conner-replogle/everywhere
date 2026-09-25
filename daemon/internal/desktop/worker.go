package desktop

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
)

// HelperName is the worker binary, installed next to the daemon.
const HelperName = "everywhere-desktop"

var errClosed = errors.New("capture closed")

// helperPath finds everywhere-desktop: $EVERYWHERE_DESKTOP_HELPER, next to the
// daemon binary, or on PATH.
func helperPath() (string, error) {
	if p := os.Getenv("EVERYWHERE_DESKTOP_HELPER"); p != "" {
		return p, nil
	}
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), HelperName)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, nil
		}
	}
	if p, err := exec.LookPath(HelperName); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("%s isn't installed next to the daemon; run `everywhere desktop enable` on the device to install it", HelperName)
}

type frame struct {
	Data       []byte
	CapturedAt time.Duration // CLOCK_MONOTONIC
	Keyframe   bool
}

// worker is one capture of one output in an everywhere-desktop process. A GPU
// encoder hang makes Mesa abort the process that owns the encoder; isolating it
// keeps the daemon alive.
type worker struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	exited  chan struct{} // closed once the process has been reaped; exitErr is then set
	exitErr error
	hello   ipc.Hello
	frames  chan *frame

	mu        sync.Mutex
	closed    bool
	err       error
	done      chan struct{} // closed when the reader exits
	closeCh   chan struct{}
	closeOnce sync.Once
	writeMu   sync.Mutex

	stdoutClose func()
}

func startWorker(cfg ipc.Config, env []string) (*worker, error) {
	exe, err := helperPath()
	if err != nil {
		return nil, err
	}
	cfgJSON, _ := json.Marshal(cfg)
	cmd := exec.Command(exe, ipc.WorkerArg, string(cfgJSON))
	cmd.Env = env
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	// A plain pipe rather than StdoutPipe: Wait must not close it before the
	// final error message has been read.
	stdout, stdoutW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Stdout = stdoutW
	err = cmd.Start()
	stdoutW.Close()
	if err != nil {
		stdout.Close()
		return nil, err
	}
	w := &worker{
		cmd:     cmd,
		stdin:   stdin,
		frames:  make(chan *frame, 16),
		done:    make(chan struct{}),
		closeCh: make(chan struct{}),
		exited:  make(chan struct{}),
	}
	go func() {
		w.exitErr = cmd.Wait()
		close(w.exited)
	}()
	w.stdoutClose = func() { stdout.Close() }
	r := bufio.NewReaderSize(stdout, 1<<20)

	typ, payload, err := ipc.ReadMsg(r)
	switch {
	case err != nil:
		w.kill()
		stdout.Close()
		return nil, fmt.Errorf("desktop worker: %w (%v)", err, w.waitErr())
	case typ == ipc.MsgError:
		w.kill()
		stdout.Close()
		return nil, errors.New(string(payload))
	case typ != ipc.MsgHello:
		w.kill()
		stdout.Close()
		return nil, fmt.Errorf("desktop worker: unexpected message %q", typ)
	}
	if err := json.Unmarshal(payload, &w.hello); err != nil {
		w.kill()
		stdout.Close()
		return nil, err
	}
	if w.hello.Version != ipc.Version {
		w.kill()
		stdout.Close()
		return nil, fmt.Errorf("%s doesn't match this daemon (protocol %d, want %d); run `everywhere update`", HelperName, w.hello.Version, ipc.Version)
	}
	go w.read(r)
	return w, nil
}

func (w *worker) read(r *bufio.Reader) {
	defer close(w.done)
	defer w.stdoutClose()
	for {
		typ, payload, err := ipc.ReadMsg(r)
		if err != nil {
			w.fail(fmt.Errorf("desktop worker exited: %v", w.waitErr()))
			return
		}
		switch typ {
		case ipc.MsgFrame:
			if len(payload) < 9 {
				continue
			}
			f := &frame{CapturedAt: time.Duration(int64(ipc.LE.Uint64(payload))) * time.Microsecond, Keyframe: payload[8] != 0, Data: payload[9:]}
			select {
			case w.frames <- f:
			case <-w.closeCh:
				return
			}
		case ipc.MsgError:
			w.fail(errors.New(string(payload)))
			return
		}
	}
}

func (w *worker) fail(err error) {
	w.mu.Lock()
	if w.err == nil && !w.closed {
		w.err = err
	}
	w.mu.Unlock()
	w.closeOnce.Do(func() { close(w.closeCh) })
}

func (w *worker) state() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.err != nil {
		return w.err
	}
	return errClosed
}

// Next blocks up to timeout for an encoded frame. It returns (nil, nil) on timeout.
func (w *worker) Next(timeout time.Duration) (*frame, error) {
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case f := <-w.frames:
		return f, nil
	case <-w.closeCh:
		return nil, w.state()
	case <-t.C:
		return nil, nil
	}
}

func (w *worker) send(b []byte) {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	_, _ = w.stdin.Write(b)
}

func (w *worker) RequestKeyframe() { w.send([]byte{ipc.CmdKeyframe}) }

func (w *worker) SetBitrate(kbps int) {
	b := []byte{ipc.CmdBitrate, 0, 0, 0, 0}
	ipc.LE.PutUint32(b[1:], uint32(kbps))
	w.send(b)
}

// Motion moves the pointer to x, y (0..65535 across the captured output).
func (w *worker) Motion(x, y uint16) {
	b := make([]byte, 5)
	b[0] = ipc.CmdMotion
	ipc.LE.PutUint16(b[1:], x)
	ipc.LE.PutUint16(b[3:], y)
	w.send(b)
}

// Button moves to x, y, then presses or releases a linux BTN_* button.
func (w *worker) Button(code uint32, pressed bool, x, y uint16) {
	b := make([]byte, 10)
	b[0] = ipc.CmdButton
	ipc.LE.PutUint32(b[1:], code)
	b[5] = boolByte(pressed)
	ipc.LE.PutUint16(b[6:], x)
	ipc.LE.PutUint16(b[8:], y)
	w.send(b)
}

// Scroll sends pixel deltas when continuous, otherwise wheel notches.
func (w *worker) Scroll(continuous bool, dx, dy float64) {
	b := make([]byte, 18)
	b[0] = ipc.CmdScroll
	b[1] = boolByte(continuous)
	ipc.LE.PutUint64(b[2:], math.Float64bits(dx))
	ipc.LE.PutUint64(b[10:], math.Float64bits(dy))
	w.send(b)
}

// Key presses or releases a linux KEY_* code.
func (w *worker) Key(code uint32, pressed bool) {
	b := make([]byte, 6)
	b[0] = ipc.CmdKey
	ipc.LE.PutUint32(b[1:], code)
	b[5] = boolByte(pressed)
	w.send(b)
}

func (w *worker) ReleaseAll() { w.send([]byte{ipc.CmdReleaseAll}) }

func boolByte(v bool) byte {
	if v {
		return 1
	}
	return 0
}

func (w *worker) Close() {
	w.mu.Lock()
	w.closed = true
	w.mu.Unlock()
	w.closeOnce.Do(func() { close(w.closeCh) })
}

// Free stops the process; Close first (or let the capture fail).
func (w *worker) Free() {
	w.Close()
	w.send([]byte{ipc.CmdQuit})
	w.stdin.Close()
	select {
	case <-w.exited:
	case <-time.After(2 * time.Second):
		slog.Warn("desktop worker did not exit; killing")
		_ = w.cmd.Process.Kill()
		<-w.exited
	}
}

func (w *worker) kill() { _ = w.cmd.Process.Kill() }

func (w *worker) waitErr() error {
	select {
	case <-w.exited:
	case <-time.After(2 * time.Second):
		return errors.New("stopped responding")
	}
	if w.exitErr == nil {
		return errors.New("exited")
	}
	return w.exitErr
}

func (w *worker) Size() (int, int)   { return w.hello.Width, w.hello.Height }
func (w *worker) OutputName() string { return w.hello.Output }
func (w *worker) InputError() string { return w.hello.InputError }
