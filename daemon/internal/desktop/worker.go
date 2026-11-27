package desktop

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"io"
	"log/slog"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
)

// HelperName is the worker, installed next to the daemon: a binary, or on
// macOS an app (worker_darwin.go).
var HelperName = "everywhere-desktop"

func init() {
	switch runtime.GOOS {
	case "windows":
		HelperName += ".exe"
	case "darwin":
		HelperName = "EverywhereDesktop.app"
	}
}

var errClosed = errors.New("capture closed")

// helperPath finds everywhere-desktop: $EVERYWHERE_DESKTOP_HELPER, next to the
// daemon binary, or on PATH.
func helperPath() (string, error) {
	if p := os.Getenv("EVERYWHERE_DESKTOP_HELPER"); p != "" {
		return p, nil
	}
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), HelperName)
		if st, err := os.Stat(p); err == nil && st.IsDir() == (runtime.GOOS == "darwin") {
			return p, nil
		}
	}
	if p, err := exec.LookPath(HelperName); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("%s isn't installed next to the daemon; run `everywhere desktop enable` on the device to install it", HelperName)
}

// workerProcess is a running worker: a child process, or on macOS the
// connection to an app that LaunchServices started.
type workerProcess interface {
	// Wait blocks until the worker has exited.
	Wait() error
	Kill() error
}

type frame struct {
	Data       []byte
	CapturedAt time.Duration // CLOCK_MONOTONIC
	Keyframe   bool
}

type cursor struct {
	ImageGen, PosGen uint64
	Inside           bool
	Captured         bool // a game hid the pointer to read the mouse's motion (Windows)
	X, Y             int  // hotspot position, in logical output coordinates (Hyprland)
	HotX, HotY       int
	Width, Height    int
	RGBA             []byte // non-nil only when the image changed
}

// worker is one capture of one output in an everywhere-desktop process. A GPU
// encoder hang makes Mesa abort the process that owns the encoder; isolating it
// keeps the daemon alive.
type worker struct {
	proc    workerProcess
	stdin   io.WriteCloser
	exited  chan struct{} // closed once the process has been reaped; exitErr is then set
	exitErr error
	hello   ipc.Hello
	frames  chan *frame
	// replies carries an agent worker's answers (MsgStill, MsgTyped).
	replies chan reply
	reqMu   sync.Mutex // one agent request at a time

	mu        sync.Mutex
	cursor    *cursor
	cursorImg []byte
	cursorSig chan struct{} // closed and replaced when cursor changes
	closed    bool
	err       error
	done      chan struct{} // closed when the reader exits
	closeCh   chan struct{}
	closeOnce sync.Once
	writeMu   sync.Mutex
	writeBuf  [32]byte

	stdoutClose func()
}

func startWorker(cfg ipc.Config, env []string) (*worker, error) {
	exe, err := helperPath()
	if err != nil {
		return nil, err
	}
	cfgJSON, _ := json.Marshal(cfg)
	// Only a person's session gets an elevated worker (Windows): an agent's
	// input stays out of programs running as administrator.
	proc, stdin, stdout, err := launchWorker(exe, cfgJSON, env, !cfg.Agent)
	if err != nil {
		return nil, err
	}
	w := &worker{
		proc:      proc,
		stdin:     stdin,
		frames:    make(chan *frame, 16),
		replies:   make(chan reply, 1),
		cursorSig: make(chan struct{}),
		done:      make(chan struct{}),
		closeCh:   make(chan struct{}),
		exited:    make(chan struct{}),
	}
	go func() {
		w.exitErr = proc.Wait()
		close(w.exited)
	}()
	w.stdoutClose = func() { stdout.Close() }
	r := bufio.NewReaderSize(stdout, 1<<20)

	typ, payload, err := ipc.ReadMsg(r)
	for err == nil && typ == ipc.MsgLog {
		workerLog(payload)
		typ, payload, err = ipc.ReadMsg(r)
	}
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
		case ipc.MsgCursor:
			w.setCursor(payload)
		case ipc.MsgLog:
			workerLog(payload)
		case ipc.MsgStill, ipc.MsgTyped:
			select {
			case w.replies <- reply{typ, payload}:
			case <-w.closeCh:
				return
			}
		case ipc.MsgError:
			w.fail(errors.New(string(payload)))
			return
		}
	}
}

// workerLog logs a line from a worker that has no stderr of its own.
func workerLog(line []byte) { slog.Info("desktop worker: " + string(line)) }

func (w *worker) setCursor(p []byte) {
	if len(p) < ipc.CursorHeaderLen {
		return
	}
	le := ipc.LE
	c := &cursor{
		ImageGen: le.Uint64(p[0:]), PosGen: le.Uint64(p[8:]),
		Inside: p[16]&ipc.CursorInside != 0, Captured: p[16]&ipc.CursorCaptured != 0,
		X: int(int32(le.Uint32(p[17:]))), Y: int(int32(le.Uint32(p[21:]))),
		HotX: int(int32(le.Uint32(p[25:]))), HotY: int(int32(le.Uint32(p[29:]))),
		Width: int(int32(le.Uint32(p[33:]))), Height: int(int32(le.Uint32(p[37:]))),
	}
	w.mu.Lock()
	if len(p) > ipc.CursorHeaderLen {
		w.cursorImg = p[ipc.CursorHeaderLen:]
	}
	w.cursor = c
	close(w.cursorSig)
	w.cursorSig = make(chan struct{})
	w.mu.Unlock()
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

// Next blocks up to timeout for an encoded frame (or indefinitely when
// timeout <= 0). It returns (nil, nil) on timeout.
func (w *worker) Next(timeout time.Duration) (*frame, error) {
	if timeout <= 0 {
		select {
		case f := <-w.frames:
			return f, nil
		case <-w.closeCh:
			return nil, w.state()
		}
	}
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

// WaitCursor blocks until the cursor differs from prev (generations), the
// timeout passes (nil, nil, when timeout > 0), or the capture closes.
func (w *worker) WaitCursor(prev *cursor, timeout time.Duration) (*cursor, error) {
	var deadlineCh <-chan time.Time
	if timeout > 0 {
		deadline := time.NewTimer(timeout)
		defer deadline.Stop()
		deadlineCh = deadline.C
	}
	for {
		w.mu.Lock()
		cur, sig, img := w.cursor, w.cursorSig, w.cursorImg
		w.mu.Unlock()
		if cur != nil && (prev == nil || cur.ImageGen != prev.ImageGen || cur.PosGen != prev.PosGen) {
			out := *cur
			if prev == nil || cur.ImageGen != prev.ImageGen {
				out.RGBA = img
			}
			return &out, nil
		}
		select {
		case <-sig:
		case <-w.closeCh:
			return nil, w.state()
		case <-deadlineCh:
			return nil, nil
		}
	}
}

func (w *worker) send(b []byte) {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	_, _ = w.stdin.Write(b)
}

func (w *worker) RequestKeyframe() {
	w.writeMu.Lock()
	w.writeBuf[0] = ipc.CmdKeyframe
	_, _ = w.stdin.Write(w.writeBuf[:1])
	w.writeMu.Unlock()
}

func (w *worker) SetBitrate(kbps int) {
	w.writeMu.Lock()
	w.writeBuf[0] = ipc.CmdBitrate
	ipc.LE.PutUint32(w.writeBuf[1:5], uint32(kbps))
	_, _ = w.stdin.Write(w.writeBuf[:5])
	w.writeMu.Unlock()
}

// Motion moves the pointer to x, y (0..65535 across the captured output).
func (w *worker) Motion(x, y uint16) {
	w.writeMu.Lock()
	w.writeBuf[0] = ipc.CmdMotion
	ipc.LE.PutUint16(w.writeBuf[1:3], x)
	ipc.LE.PutUint16(w.writeBuf[3:5], y)
	_, _ = w.stdin.Write(w.writeBuf[:5])
	w.writeMu.Unlock()
}

// MotionBy moves the pointer by dx, dy output pixels, as a mouse does.
func (w *worker) MotionBy(dx, dy float32) {
	w.writeMu.Lock()
	w.writeBuf[0] = ipc.CmdMotionBy
	ipc.LE.PutUint32(w.writeBuf[1:5], math.Float32bits(dx))
	ipc.LE.PutUint32(w.writeBuf[5:9], math.Float32bits(dy))
	_, _ = w.stdin.Write(w.writeBuf[:9])
	w.writeMu.Unlock()
}

// ButtonHere presses or releases a linux BTN_* button where the pointer is.
func (w *worker) ButtonHere(code uint32, pressed bool) {
	w.writeMu.Lock()
	w.writeBuf[0] = ipc.CmdButtonHere
	ipc.LE.PutUint32(w.writeBuf[1:5], code)
	w.writeBuf[5] = boolByte(pressed)
	_, _ = w.stdin.Write(w.writeBuf[:6])
	w.writeMu.Unlock()
}

// Button moves to x, y, then presses or releases a linux BTN_* button.
func (w *worker) Button(code uint32, pressed bool, x, y uint16) {
	w.writeMu.Lock()
	w.writeBuf[0] = ipc.CmdButton
	ipc.LE.PutUint32(w.writeBuf[1:5], code)
	w.writeBuf[5] = boolByte(pressed)
	ipc.LE.PutUint16(w.writeBuf[6:8], x)
	ipc.LE.PutUint16(w.writeBuf[8:10], y)
	_, _ = w.stdin.Write(w.writeBuf[:10])
	w.writeMu.Unlock()
}

// Scroll sends pixel deltas when continuous, otherwise wheel notches.
func (w *worker) Scroll(continuous bool, dx, dy float64) {
	w.writeMu.Lock()
	w.writeBuf[0] = ipc.CmdScroll
	w.writeBuf[1] = boolByte(continuous)
	ipc.LE.PutUint64(w.writeBuf[2:10], math.Float64bits(dx))
	ipc.LE.PutUint64(w.writeBuf[10:18], math.Float64bits(dy))
	_, _ = w.stdin.Write(w.writeBuf[:18])
	w.writeMu.Unlock()
}

// Key presses or releases a linux KEY_* code.
func (w *worker) Key(code uint32, pressed bool) {
	w.writeMu.Lock()
	w.writeBuf[0] = ipc.CmdKey
	ipc.LE.PutUint32(w.writeBuf[1:5], code)
	w.writeBuf[5] = boolByte(pressed)
	_, _ = w.stdin.Write(w.writeBuf[:6])
	w.writeMu.Unlock()
}

func (w *worker) ReleaseAll() {
	w.writeMu.Lock()
	w.writeBuf[0] = ipc.CmdReleaseAll
	_, _ = w.stdin.Write(w.writeBuf[:1])
	w.writeMu.Unlock()
}

type reply struct {
	typ     byte
	payload []byte
}

// request sends an agent worker a command and waits for its reply.
func (w *worker) request(cmd []byte, want byte, timeout time.Duration) ([]byte, error) {
	w.reqMu.Lock()
	defer w.reqMu.Unlock()
	w.send(cmd)
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case r := <-w.replies:
		if r.typ != want {
			return nil, fmt.Errorf("desktop worker: unexpected reply %q", r.typ)
		}
		return r.payload, nil
	case <-w.closeCh:
		return nil, w.state()
	case <-t.C:
		w.fail(errors.New("desktop worker stopped responding"))
		return nil, w.state()
	}
}

// Still takes a screenshot of the agent worker's window or output.
func (w *worker) Still() (*image.RGBA, error) {
	p, err := w.request([]byte{ipc.CmdStill}, ipc.MsgStill, 10*time.Second)
	if err != nil {
		return nil, err
	}
	if len(p) < 1 || p[0] != 1 {
		if len(p) > 1 {
			return nil, errors.New(string(p[1:]))
		}
		return nil, errors.New("screenshot failed")
	}
	if len(p) < 9 {
		return nil, errors.New("desktop worker: short screenshot")
	}
	wd, ht := int(ipc.LE.Uint32(p[1:])), int(ipc.LE.Uint32(p[5:]))
	if len(p)-9 != wd*ht*4 {
		return nil, errors.New("desktop worker: screenshot size mismatch")
	}
	return &image.RGBA{Pix: p[9:], Stride: wd * 4, Rect: image.Rect(0, 0, wd, ht)}, nil
}

// Type types one character; false means the keyboard layout has no key for it.
func (w *worker) Type(r rune) (bool, error) {
	b := make([]byte, 5)
	b[0] = ipc.CmdType
	ipc.LE.PutUint32(b[1:], uint32(r))
	p, err := w.request(b, ipc.MsgTyped, 5*time.Second)
	if err != nil {
		return false, err
	}
	return len(p) == 1 && p[0] == 0, nil
}

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
		_ = w.proc.Kill()
		<-w.exited
	}
}

func (w *worker) kill() { _ = w.proc.Kill() }

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
