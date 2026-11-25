package gamepad

import (
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"golang.org/x/sys/windows"
)

// ViGEmBus is a bus driver that plugs in virtual controllers on request. Its
// interface is a handful of IOCTLs on the bus device (ViGEmBusShared.h in
// ViGEmClient); talking to it directly keeps the daemon free of cgo and of
// ViGEmClient.dll. A controller belongs to the handle that plugged it in:
// closing the handle unplugs it, so a crashed daemon leaves none behind.

// busInterface is GUID_DEVINTERFACE_BUSENUM_VIGEM.
var busInterface = windows.GUID{Data1: 0x96E42B22, Data2: 0xF5E9, Data3: 0x42F8, Data4: [8]byte{0xB0, 0x43, 0xED, 0x0F, 0x93, 0x2F, 0x01, 0x4F}}

const (
	fileRead  = 1
	fileWrite = 2
	ioctlBase = 0x801
)

// busIOCTL is CTL_CODE(FILE_DEVICE_BUS_EXTENDER, ioctlBase+fn, METHOD_BUFFERED, access).
func busIOCTL(fn, access uint32) uint32 { return 0x2A<<16 | access<<14 | (ioctlBase+fn)<<2 }

var (
	ioctlPlugin       = busIOCTL(0x000, fileWrite)
	ioctlUnplug       = busIOCTL(0x001, fileWrite)
	ioctlCheckVersion = busIOCTL(0x002, fileWrite)
	ioctlWaitReady    = busIOCTL(0x003, fileWrite)
	ioctlXUSBNotify   = busIOCTL(0x200, fileRead|fileWrite)
	ioctlXUSBSubmit   = busIOCTL(0x201, fileWrite)
)

const (
	commonVersion = 1      // VIGEM_COMMON_VERSION
	targetXbox360 = 0      // Xbox360Wired
	vendorID      = 0x045E // Microsoft
	productID     = 0x028E // Xbox 360 Controller
	maxSerial     = 64     // serials are per bus; other programs' controllers hold some
)

var le = binary.LittleEndian

var errPlugFailed = errors.New("plugging the controller in failed a moment ago")

var avail struct {
	sync.Mutex
	at  time.Time
	err error
}

// Available reports why controllers can't be plugged in, or nil if they can.
// The answer is cached for a few seconds.
func Available() error {
	avail.Lock()
	defer avail.Unlock()
	if time.Since(avail.at) > 5*time.Second {
		_, avail.err = busPath()
		avail.at = time.Now()
	}
	return avail.err
}

func busPath() (string, error) {
	paths, err := windows.CM_Get_Device_Interface_List("", &busInterface, windows.CM_GET_DEVICE_INTERFACE_LIST_PRESENT)
	if err == nil {
		for _, p := range paths {
			if p != "" {
				return p, nil
			}
		}
	}
	return "", errors.New("the ViGEmBus driver isn't installed")
}

// Bus is a session's virtual controllers, plugged in as the viewer's
// controllers first send their state.
type Bus struct {
	h        windows.Handle
	onRumble RumbleFunc

	mu     sync.Mutex // guards everything below, and serializes requests on ev
	closed bool
	pads   [MaxPads]*pad
	// plugFailed is when plugging each controller in last failed: its
	// state comes many times a second, and each try is many requests.
	plugFailed [MaxPads]time.Time
	ev         windows.Handle
	ov         *windows.Overlapped
}

type pad struct {
	serial uint32
	state  State
	ev     windows.Handle      // the notification request's
	ov     *windows.Overlapped // the pending notification request, guarded by Bus.mu
	stop   bool
	done   chan struct{}
}

// Open connects to the bus driver. onRumble may be nil.
func Open(onRumble RumbleFunc) (*Bus, error) {
	path, err := busPath()
	if err != nil {
		return nil, err
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil,
		windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_NO_BUFFERING|windows.FILE_FLAG_WRITE_THROUGH|windows.FILE_FLAG_OVERLAPPED, 0)
	if err != nil {
		return nil, fmt.Errorf("opening the ViGEmBus driver: %w", err)
	}
	ev, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		windows.CloseHandle(h)
		return nil, err
	}
	b := &Bus{h: h, onRumble: onRumble, ev: ev, ov: new(windows.Overlapped)}
	in := make([]byte, 8)
	le.PutUint32(in[0:], 8)
	le.PutUint32(in[4:], commonVersion)
	if err := b.ioctlLocked(ioctlCheckVersion, in, nil); err != nil {
		b.Close()
		return nil, fmt.Errorf("the ViGEmBus driver is a version this doesn't speak: %w", err)
	}
	return b, nil
}

// ioctlLocked makes one request and waits for it. Must hold b.mu (or be opening).
func (b *Bus) ioctlLocked(code uint32, in, out []byte) error {
	*b.ov = windows.Overlapped{HEvent: b.ev}
	return ioctl(b.h, code, in, out, b.ov)
}

// ioctl makes a request with ov (on the heap, which doesn't move, so the
// driver can write to it) and waits for it to complete.
func ioctl(h windows.Handle, code uint32, in, out []byte, ov *windows.Overlapped) error {
	var inp, outp *byte
	if len(in) > 0 {
		inp = &in[0]
	}
	if len(out) > 0 {
		outp = &out[0]
	}
	var n uint32
	err := windows.DeviceIoControl(h, code, inp, uint32(len(in)), outp, uint32(len(out)), &n, ov)
	if errors.Is(err, windows.ERROR_IO_PENDING) {
		err = windows.GetOverlappedResult(h, ov, &n, true)
	}
	return err
}

// Set gives controller index (0..MaxPads-1) state s, plugging it in first
// if it isn't.
func (b *Bus) Set(index int, s State) error {
	if index < 0 || index >= MaxPads {
		return fmt.Errorf("no controller %d", index)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return errors.New("controllers closed")
	}
	p := b.pads[index]
	if p == nil {
		if time.Since(b.plugFailed[index]) < 2*time.Second {
			return errPlugFailed
		}
		var err error
		if p, err = b.plugLocked(index); err != nil {
			b.plugFailed[index] = time.Now()
			return err
		}
	} else if p.state == s {
		return nil
	}
	in := make([]byte, 20)
	le.PutUint32(in[0:], 20)
	le.PutUint32(in[4:], p.serial)
	le.PutUint16(in[8:], s.Buttons)
	in[10], in[11] = s.LT, s.RT
	for i, v := range []int16{s.LX, s.LY, s.RX, s.RY} {
		le.PutUint16(in[12+2*i:], uint16(v))
	}
	if err := b.ioctlLocked(ioctlXUSBSubmit, in, nil); err != nil {
		return fmt.Errorf("controller %d: %w", index+1, err)
	}
	p.state = s
	return nil
}

func (b *Bus) plugLocked(index int) (*pad, error) {
	in := make([]byte, 16)
	var err error
	for serial := uint32(1); serial <= maxSerial; serial++ {
		le.PutUint32(in[0:], 16)
		le.PutUint32(in[4:], serial)
		le.PutUint32(in[8:], targetXbox360)
		le.PutUint16(in[12:], vendorID)
		le.PutUint16(in[14:], productID)
		if err = b.ioctlLocked(ioctlPlugin, in, nil); err != nil {
			continue // another controller has this serial
		}
		wait := make([]byte, 8)
		le.PutUint32(wait[0:], 8)
		le.PutUint32(wait[4:], serial)
		_ = b.ioctlLocked(ioctlWaitReady, wait, nil) // drivers before 1.17 don't have it, and are ready at once
		ev, evErr := windows.CreateEvent(nil, 1, 0, nil)
		if evErr != nil {
			b.unplugSerialLocked(serial)
			return nil, evErr
		}
		p := &pad{serial: serial, ev: ev, done: make(chan struct{})}
		b.pads[index] = p
		go b.notifications(index, p)
		slog.Info("gamepad plugged in", "index", index, "serial", serial)
		return p, nil
	}
	return nil, fmt.Errorf("plugging in controller %d: %w", index+1, err)
}

// notifications waits for a game to set p's motors, and passes them on.
func (b *Bus) notifications(index int, p *pad) {
	defer close(p.done)
	buf := make([]byte, 12)
	var last [2]byte
	for {
		b.mu.Lock()
		if p.stop {
			b.mu.Unlock()
			return
		}
		p.ov = &windows.Overlapped{HEvent: p.ev}
		ov := p.ov
		b.mu.Unlock()
		clear(buf)
		le.PutUint32(buf[0:], 12)
		le.PutUint32(buf[4:], p.serial)
		if err := ioctl(b.h, ioctlXUSBNotify, buf, buf, ov); err != nil {
			return // unplugged, or the bus went away
		}
		if m := [2]byte{buf[8], buf[9]}; m != last {
			last = m
			if b.onRumble != nil {
				b.onRumble(index, m[0], m[1])
			}
		}
	}
}

// Unplug removes controller index, if it's plugged in.
func (b *Bus) Unplug(index int) {
	if index < 0 || index >= MaxPads {
		return
	}
	b.mu.Lock()
	p := b.pads[index]
	b.pads[index] = nil
	if p != nil {
		b.stopLocked(p)
	}
	b.mu.Unlock()
	if p != nil {
		b.reap(index, p)
	}
}

// stopLocked unplugs p and cancels its notification request.
func (b *Bus) stopLocked(p *pad) {
	p.stop = true
	if p.ov != nil {
		_ = windows.CancelIoEx(b.h, p.ov)
	}
	b.unplugSerialLocked(p.serial)
}

func (b *Bus) unplugSerialLocked(serial uint32) {
	in := make([]byte, 8)
	le.PutUint32(in[0:], 8)
	le.PutUint32(in[4:], serial)
	if err := b.ioctlLocked(ioctlUnplug, in, nil); err != nil {
		slog.Debug("gamepad unplug", "serial", serial, "err", err)
	}
}

// reap waits for p's notifications to stop, then frees its event.
func (b *Bus) reap(index int, p *pad) {
	select {
	case <-p.done:
		windows.CloseHandle(p.ev)
	case <-time.After(time.Second):
		slog.Warn("gamepad notifications didn't stop", "index", index) // Close cancels them with the handle
	}
	slog.Info("gamepad unplugged", "index", index)
}

// Close unplugs every controller.
func (b *Bus) Close() {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}
	b.closed = true
	var pads [MaxPads]*pad
	for i, p := range b.pads {
		if p != nil {
			b.stopLocked(p)
			pads[i] = p
		}
	}
	b.pads = [MaxPads]*pad{}
	b.mu.Unlock()
	for i, p := range pads {
		if p != nil {
			b.reap(i, p)
		}
	}
	windows.CloseHandle(b.h) // unplugs anything left, and ends pending requests
	windows.CloseHandle(b.ev)
}
