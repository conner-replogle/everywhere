package capture

import (
	"errors"
	"fmt"
	"image"
	"log/slog"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
	"github.com/conner-replogle/everywhere/daemon/internal/desktop/win32"
)

// On Windows a capture duplicates one display with DXGI Desktop Duplication
// (cropping to a window for a window stream), converts it to NV12 with the
// GPU's video processor, and encodes H.264 with a Media Foundation encoder:
// the GPU's own, or Microsoft's software one. The cursor comes separately,
// as it does on Linux. Screenshots go through GDI and need no GPU.

type Frame struct {
	Data       []byte
	CapturedAt time.Duration // since the capture started
	Keyframe   bool
}

type Output struct {
	Name          string
	Width, Height int
}

type Cursor struct {
	ImageGen, PosGen uint64
	Inside           bool
	X, Y             int // hotspot position in captured pixels
	HotX, HotY       int
	Width, Height    int
	RGBA             []byte // non-nil only when the image changed
}

var ErrClosed = errors.New("capture closed")

// debug logs every duplicated frame (EVERYWHERE_DESKTOP_DEBUG=1).
var debug = os.Getenv("EVERYWHERE_DESKTOP_DEBUG") != ""

type Capture struct {
	cfg           ipc.Config
	width, height int
	output        string

	frames    chan *Frame
	keyframe  atomic.Bool
	bitrate   atomic.Int64
	closed    chan struct{}
	closeOnce sync.Once
	done      chan struct{}
	err       error // why the loop stopped, once done is closed

	curMu  sync.Mutex
	cur    Cursor
	curImg []byte
	curSig chan struct{} // closed and replaced when cur changes
}

// Start begins capturing cfg.Output (a display name; "" for the primary one),
// or the window cfg.Window on it.
func Start(cfg ipc.Config) (*Capture, error) {
	if cfg.Codec != ipc.H264 {
		return nil, errors.New("only H.264 is supported on Windows")
	}
	c := &Capture{
		cfg: cfg, frames: make(chan *Frame, 8), closed: make(chan struct{}), done: make(chan struct{}),
		curSig: make(chan struct{}),
	}
	ready := make(chan error, 1)
	go c.run(ready)
	if err := <-ready; err != nil {
		<-c.done
		return nil, err
	}
	return c, nil
}

func (c *Capture) RequestKeyframe()    { c.keyframe.Store(true) }
func (c *Capture) SetBitrate(kbps int) { c.bitrate.Store(int64(kbps)) }
func (c *Capture) Close()              { c.closeOnce.Do(func() { close(c.closed) }) }
func (c *Capture) Free()               { c.Close(); <-c.done }
func (c *Capture) Size() (int, int)    { return c.width, c.height }
func (c *Capture) OutputName() string  { return c.output }

// Next blocks up to timeout for an encoded frame. It returns (nil, nil) on timeout.
func (c *Capture) Next(timeout time.Duration) (*Frame, error) {
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case f := <-c.frames:
		return f, nil
	case <-c.done:
		select {
		case f := <-c.frames:
			return f, nil
		default:
		}
		if c.err != nil {
			return nil, c.err
		}
		return nil, ErrClosed
	case <-t.C:
		return nil, nil
	}
}

// WaitCursor blocks until the cursor differs from prev (generations), the
// timeout passes (nil, nil), or the capture closes (ErrClosed).
func (c *Capture) WaitCursor(prev *Cursor, timeout time.Duration) (*Cursor, error) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		c.curMu.Lock()
		cur, img, sig := c.cur, c.curImg, c.curSig
		c.curMu.Unlock()
		var was Cursor
		if prev != nil {
			was = *prev
		}
		if cur.ImageGen != was.ImageGen || cur.PosGen != was.PosGen {
			if cur.ImageGen != was.ImageGen {
				cur.RGBA = img
			}
			return &cur, nil
		}
		select {
		case <-sig:
		case <-c.done:
			return nil, ErrClosed
		case <-deadline.C:
			return nil, nil
		}
	}
}

func (c *Capture) setCursor(update func(*Cursor) bool, img []byte) {
	c.curMu.Lock()
	defer c.curMu.Unlock()
	if !update(&c.cur) {
		return
	}
	if img != nil {
		c.curImg = img
	}
	close(c.curSig)
	c.curSig = make(chan struct{})
}

func ListOutputs() ([]Output, error) {
	mons, err := win32.Monitors()
	if err != nil {
		return nil, err
	}
	out := make([]Output, len(mons))
	for i, m := range mons {
		out[i] = Output{Name: m.Name, Width: m.Rect.Width(), Height: m.Rect.Height()}
	}
	return out, nil
}

// Screenshot copies window (its id) or, without one, the display output.
func Screenshot(output, window string) (*image.RGBA, error) {
	if window != "" {
		h, err := win32.ParseID(window)
		if err != nil {
			return nil, err
		}
		if !win32.Alive(h) {
			return nil, errors.New("window closed")
		}
		return win32.WindowScreenshot(h)
	}
	m, err := win32.FindMonitor(output)
	if err != nil {
		return nil, err
	}
	return win32.Screenshot(m.Rect)
}

// quality maps VA-API's target usage (1 best .. 7 fastest) to Media
// Foundation's quality-versus-speed (0 fastest .. 100 best).
func quality(targetUsage int) int {
	if targetUsage < 1 || targetUsage > 7 {
		targetUsage = 4
	}
	return (7 - targetUsage) * 100 / 6
}

// pipeline is what run sets up on its thread.
type pipeline struct {
	g    *gpu
	src  iface // BGRA copy of the latest desktop image
	conv *converter
	enc  *encoder

	mon  win32.Monitor
	hwnd windows.HWND
	crop rect // what's captured, in desktop-image pixels
}

func (c *Capture) run(ready chan<- error) {
	defer close(c.done)
	runtime.LockOSThread() // COM objects stay on the thread that made them
	defer runtime.UnlockOSThread()
	if err := windows.CoInitializeEx(0, windows.COINIT_MULTITHREADED); err != nil {
		ready <- err
		return
	}
	defer windows.CoUninitialize()
	if err := callProc(procMFStartup, mfVersion, 0); err != nil {
		ready <- fmt.Errorf("starting Media Foundation: %w", err)
		return
	}
	defer procMFShutdown.Call()

	p, err := c.setup()
	if err != nil {
		ready <- err
		return
	}
	defer p.close()
	ready <- nil
	c.err = c.loop(p)
}

func (c *Capture) setup() (*pipeline, error) {
	p := &pipeline{}
	var err error
	if p.mon, err = win32.FindMonitor(c.cfg.Output); err != nil {
		return nil, err
	}
	if p.g, err = openGPU(p.mon.Device); err != nil {
		return nil, err
	}
	c.output = p.mon.Name
	p.crop = rect{0, 0, int32(p.g.width), int32(p.g.height)}
	c.width, c.height = p.g.width, p.g.height
	if c.cfg.Window != "" {
		if p.hwnd, err = win32.ParseID(c.cfg.Window); err != nil {
			p.close()
			return nil, err
		}
		crop, err := p.windowCrop()
		if err != nil {
			p.close()
			return nil, err
		}
		p.crop = crop
		c.width, c.height = int(crop.Right-crop.Left), int(crop.Bottom-crop.Top)
	}
	w, h := c.cfg.Width, c.cfg.Height
	if w <= 0 || h <= 0 {
		w, h = c.width, c.height
	}
	w, h = max(w&^1, 2), max(h&^1, 2)
	if p.src, err = p.g.texture(p.g.width, p.g.height, formatB8G8R8A8, bindRenderTarget|bindShaderResource); err != nil {
		p.close()
		return nil, err
	}
	if p.conv, err = newConverter(p.g, p.src, p.g.width, p.g.height, w, h); err != nil {
		p.close()
		return nil, err
	}
	kbps := c.cfg.BitrateKbps
	if kbps <= 0 {
		kbps = 8000
	}
	if p.enc, err = newEncoder(p.g, w, h, kbps, quality(c.cfg.TargetUsage)); err != nil {
		p.close()
		return nil, err
	}
	return p, nil
}

// windowCrop is the window's part of the display, in desktop-image pixels.
func (p *pipeline) windowCrop() (rect, error) {
	if !win32.Alive(p.hwnd) {
		return rect{}, errors.New("window closed")
	}
	b, err := win32.Bounds(p.hwnd)
	if err != nil {
		return rect{}, err
	}
	m := p.mon.Rect
	r := rect{
		max(b.Left, m.Left) - m.Left, max(b.Top, m.Top) - m.Top,
		min(b.Right, m.Right) - m.Left, min(b.Bottom, m.Bottom) - m.Top,
	}
	if r.Right-r.Left < 2 || r.Bottom-r.Top < 2 {
		return rect{}, errors.New("the window isn't on its display")
	}
	return r, nil
}

func (p *pipeline) close() {
	if p.enc != nil {
		p.enc.close()
	}
	if p.conv != nil {
		p.conv.close()
	}
	p.src.release()
	if p.g != nil {
		p.g.close()
	}
}

func (c *Capture) loop(p *pipeline) error {
	start := time.Now()
	var minGap time.Duration
	if c.cfg.MaxFPS > 0 {
		minGap = time.Second / time.Duration(c.cfg.MaxFPS)
	}
	var (
		have, dirty bool
		capturedAt  time.Duration
		lastSubmit  time.Time
		lastWindow  time.Time
		shape       []byte
		emitted     int
	)
	emit := func(e encodedFrame) {
		emitted++
		f := &Frame{Data: e.data, Keyframe: e.keyframe, CapturedAt: time.Duration(e.at) * 100}
		select {
		case c.frames <- f:
		case <-c.closed:
		}
	}
	for {
		select {
		case <-c.closed:
			return nil
		default:
		}
		if kbps := c.bitrate.Swap(0); kbps > 0 {
			p.enc.setBitrate(int(kbps))
		}
		if c.keyframe.Swap(false) {
			p.enc.forceKeyframe()
			dirty = dirty || have // a still screen: send the last image again
		}

		// A window stream follows its window, and ends with it.
		if p.hwnd != 0 && time.Since(lastWindow) > 100*time.Millisecond {
			lastWindow = time.Now()
			if !win32.Alive(p.hwnd) {
				return errors.New("window closed")
			}
			if !win32.Minimized(p.hwnd) {
				crop, err := p.windowCrop()
				if err != nil {
					return err
				}
				if w, h := int(crop.Right-crop.Left), int(crop.Bottom-crop.Top); w != c.width || h != c.height {
					return fmt.Errorf("capture size changed: %dx%d", w, h)
				}
				if crop != p.crop {
					p.crop, dirty = crop, dirty || have
				}
			}
		}

		var info frameInfo
		var res iface
		timeout := 16
		if dirty {
			timeout = 1
		}
		err := p.g.dupl.hcall("AcquireNextFrame", duplAcquireNext, uintptr(timeout), uintptr(unsafe.Pointer(&info)), uintptr(unsafe.Pointer(&res)))
		switch {
		case err == nil:
			if info.LastPresentTime != 0 {
				if tex, err := res.queryInterface(&iidID3D11Texture2D); err == nil {
					if w, h := textureSize(tex); w != p.g.width || h != p.g.height {
						tex.release()
						res.release()
						p.g.dupl.call(duplReleaseFrame)
						return fmt.Errorf("capture size changed: %dx%d", w, h)
					}
					p.g.context.call(contextCopyResource, uintptr(p.src), uintptr(tex))
					tex.release()
					have, dirty, capturedAt = true, true, time.Since(start)
				}
			}
			if debug {
				slog.Info("frame", "present", info.LastPresentTime, "mouse", info.LastMouseUpdateTime, "shape", info.PointerShapeSize,
					"pointer", [2]int32{info.PointerX, info.PointerY}, "visible", info.PointerVisible)
			}
			if info.LastMouseUpdateTime != 0 {
				if info.PointerShapeSize > 0 {
					shape = c.pointerShape(p, info.PointerShapeSize, shape)
				}
				c.pointerMoved(p, info)
			}
			res.release()
			p.g.dupl.call(duplReleaseFrame)
		case is(err, dxgiErrorWaitTimeout):
		case is(err, dxgiErrorAccessLost), is(err, eAccessDenied), is(err, dxgiErrorSessionDisconnect):
			// A mode change, the secure desktop (UAC, the lock screen), or a
			// fullscreen app: duplicate again once it's possible.
			for {
				if err := p.g.duplicate(); err == nil {
					break
				}
				select {
				case <-c.closed:
					return nil
				case <-time.After(250 * time.Millisecond):
				}
			}
			if w, h := textureSize(p.src); p.g.width != w || p.g.height != h {
				return fmt.Errorf("capture size changed: %dx%d", p.g.width, p.g.height)
			}
			dirty = dirty || have
		default:
			return fmt.Errorf("capturing the screen: %w", err)
		}

		if err := p.enc.pump(emit); err != nil {
			return fmt.Errorf("encoding: %w", err)
		}
		if dirty && p.enc.ready() && time.Since(lastSubmit) >= minGap {
			nv12, err := p.conv.convert(p.crop)
			if err != nil {
				return fmt.Errorf("converting the frame: %w", err)
			}
			before := emitted
			if err := p.enc.encode(nv12, int64(capturedAt/100), emit); err != nil {
				return fmt.Errorf("encoding: %w", err)
			}
			dirty, lastSubmit = false, time.Now()
			// A hardware encoder answers within milliseconds; wait for it
			// rather than for the next screen update.
			for deadline := time.Now().Add(40 * time.Millisecond); emitted == before && time.Now().Before(deadline); {
				if err := p.enc.pump(emit); err != nil {
					return fmt.Errorf("encoding: %w", err)
				}
				if emitted == before {
					time.Sleep(time.Millisecond)
				}
			}
		}
	}
}

// pointerMoved records where the pointer is: its hotspot, relative to what's
// captured.
func (c *Capture) pointerMoved(p *pipeline, info frameInfo) {
	c.setCursor(func(cur *Cursor) bool {
		x, y := int(info.PointerX)+cur.HotX-int(p.crop.Left), int(info.PointerY)+cur.HotY-int(p.crop.Top)
		inside := info.PointerVisible != 0 && x >= 0 && y >= 0 && x < c.width && y < c.height
		if cur.X == x && cur.Y == y && cur.Inside == inside && cur.PosGen != 0 {
			return false
		}
		cur.X, cur.Y, cur.Inside = x, y, inside
		cur.PosGen++
		return true
	}, nil)
}

const (
	pointerMonochrome  = 1
	pointerColor       = 2
	pointerMaskedColor = 4
)

// pointerShape fetches a new pointer image as RGBA.
func (c *Capture) pointerShape(p *pipeline, size uint32, buf []byte) []byte {
	if uint32(len(buf)) < size {
		buf = make([]byte, size)
	}
	var need uint32
	var si pointerShapeInfo
	if p.g.dupl.call(duplGetPointerShape, uintptr(size), uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&need)), uintptr(unsafe.Pointer(&si))) != 0 {
		return buf
	}
	w, h := int(si.Width), int(si.Height)
	if si.Type == pointerMonochrome {
		h /= 2
	}
	if w <= 0 || h <= 0 {
		return buf
	}
	rgba := make([]byte, w*h*4)
	pitch := int(si.Pitch)
	for y := range h {
		for x := range w {
			o := (y*w + x) * 4
			switch si.Type {
			case pointerColor:
				s := buf[y*pitch+x*4:]
				rgba[o], rgba[o+1], rgba[o+2], rgba[o+3] = s[2], s[1], s[0], s[3]
			case pointerMaskedColor:
				// The alpha byte is a mask: 0 draws the colour, 0xFF XORs it
				// with the screen, which an image can't; black shows it.
				s := buf[y*pitch+x*4:]
				if s[3] == 0 {
					rgba[o], rgba[o+1], rgba[o+2], rgba[o+3] = s[2], s[1], s[0], 255
				} else if s[0]|s[1]|s[2] != 0 {
					rgba[o+3] = 255
				}
			case pointerMonochrome:
				bit := byte(0x80) >> (x % 8)
				and := buf[y*pitch+x/8]&bit != 0
				xor := buf[(y+h)*pitch+x/8]&bit != 0
				switch {
				case !and && !xor: // black
					rgba[o+3] = 255
				case !and && xor: // white
					rgba[o], rgba[o+1], rgba[o+2], rgba[o+3] = 255, 255, 255, 255
				case and && xor: // inverts the screen; black shows it
					rgba[o+3] = 255
				}
			}
		}
	}
	c.setCursor(func(cur *Cursor) bool {
		cur.Width, cur.Height, cur.HotX, cur.HotY = w, h, int(si.HotX), int(si.HotY)
		cur.ImageGen++
		return true
	}, rgba)
	return buf
}
