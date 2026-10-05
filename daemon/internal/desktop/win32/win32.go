//go:build windows

// Package win32 is the slice of user32, gdi32 and dwmapi that remote desktop
// needs on Windows: monitors, top-level windows, focus, the clipboard,
// injected input and GDI screenshots. Everything is in physical pixels: the
// process is made per-monitor DPI aware on load.
package win32

import (
	"errors"
	"fmt"
	"image"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32 = windows.NewLazySystemDLL("user32.dll")
	gdi32  = windows.NewLazySystemDLL("gdi32.dll")

	procSetProcessDpiAwarenessContext = user32.NewProc("SetProcessDpiAwarenessContext")
	procEnumDisplayMonitors           = user32.NewProc("EnumDisplayMonitors")
	procGetMonitorInfoW               = user32.NewProc("GetMonitorInfoW")
	procMonitorFromWindow             = user32.NewProc("MonitorFromWindow")
	procGetWindowTextW                = user32.NewProc("GetWindowTextW")
	procGetWindowTextLengthW          = user32.NewProc("GetWindowTextLengthW")
	procGetWindow                     = user32.NewProc("GetWindow")
	procGetWindowLongPtrW             = user32.NewProc("GetWindowLongPtrW")
	procIsIconic                      = user32.NewProc("IsIconic")
	procGetWindowPlacement            = user32.NewProc("GetWindowPlacement")
	procShowWindow                    = user32.NewProc("ShowWindow")
	procSetForegroundWindow           = user32.NewProc("SetForegroundWindow")
	procBringWindowToTop              = user32.NewProc("BringWindowToTop")
	procAttachThreadInput             = user32.NewProc("AttachThreadInput")
	procGetWindowRect                 = user32.NewProc("GetWindowRect")
	procGetSystemMetrics              = user32.NewProc("GetSystemMetrics")
	procSendInput                     = user32.NewProc("SendInput")
	procOpenClipboard                 = user32.NewProc("OpenClipboard")
	procCloseClipboard                = user32.NewProc("CloseClipboard")
	procEmptyClipboard                = user32.NewProc("EmptyClipboard")
	procGetClipboardData              = user32.NewProc("GetClipboardData")
	procSetClipboardData              = user32.NewProc("SetClipboardData")
	procGetClipboardSequenceNumber    = user32.NewProc("GetClipboardSequenceNumber")
	procGetDC                         = user32.NewProc("GetDC")
	procReleaseDC                     = user32.NewProc("ReleaseDC")
	procPrintWindow                   = user32.NewProc("PrintWindow")
	procGetCursorPos                  = user32.NewProc("GetCursorPos")

	procCreateCompatibleDC = gdi32.NewProc("CreateCompatibleDC")
	procCreateDIBSection   = gdi32.NewProc("CreateDIBSection")
	procSelectObject       = gdi32.NewProc("SelectObject")
	procBitBlt             = gdi32.NewProc("BitBlt")
	procDeleteObject       = gdi32.NewProc("DeleteObject")
	procDeleteDC           = gdi32.NewProc("DeleteDC")
	procGdiFlush           = gdi32.NewProc("GdiFlush")

	kernel32         = windows.NewLazySystemDLL("kernel32.dll")
	procGlobalAlloc  = kernel32.NewProc("GlobalAlloc")
	procGlobalFree   = kernel32.NewProc("GlobalFree")
	procGlobalLock   = kernel32.NewProc("GlobalLock")
	procGlobalUnlock = kernel32.NewProc("GlobalUnlock")
)

func init() {
	// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: coordinates are physical
	// pixels on every monitor. Fails harmlessly if already set.
	if procSetProcessDpiAwarenessContext.Find() == nil {
		procSetProcessDpiAwarenessContext.Call(^uintptr(3)) // (DPI_AWARENESS_CONTEXT)-4
	}
}

// Rect is a rectangle in virtual-screen pixels.
type Rect struct{ Left, Top, Right, Bottom int32 }

func (r Rect) Width() int  { return int(r.Right - r.Left) }
func (r Rect) Height() int { return int(r.Bottom - r.Top) }

// Monitor is one display.
type Monitor struct {
	Handle  uintptr
	Name    string // DISPLAY1
	Device  string // \\.\DISPLAY1, as DXGI names its output
	Rect    Rect
	Primary bool
}

type monitorInfoEx struct {
	Size    uint32
	Monitor Rect
	Work    Rect
	Flags   uint32
	Device  [32]uint16
}

// Monitors lists the displays, the primary one first.
func Monitors() ([]Monitor, error) {
	var mons []Monitor
	cb := syscall.NewCallback(func(h, _ uintptr, _ *Rect, _ uintptr) uintptr {
		if m, ok := monitorInfo(h); ok {
			mons = append(mons, m)
		}
		return 1
	})
	if r, _, err := procEnumDisplayMonitors.Call(0, 0, cb, 0); r == 0 {
		return nil, fmt.Errorf("EnumDisplayMonitors: %w", err)
	}
	for i, m := range mons {
		if m.Primary && i > 0 {
			mons[0], mons[i] = mons[i], mons[0]
		}
	}
	return mons, nil
}

func monitorInfo(h uintptr) (Monitor, bool) {
	info := monitorInfoEx{Size: uint32(unsafe.Sizeof(monitorInfoEx{}))}
	if r, _, _ := procGetMonitorInfoW.Call(h, uintptr(unsafe.Pointer(&info))); r == 0 {
		return Monitor{}, false
	}
	dev := windows.UTF16ToString(info.Device[:])
	return Monitor{
		Handle: h, Device: dev, Name: strings.TrimPrefix(dev, `\\.\`),
		Rect: info.Monitor, Primary: info.Flags&1 != 0,
	}, true
}

// FindMonitor finds a display by name; "" is the primary one.
func FindMonitor(name string) (Monitor, error) {
	mons, err := Monitors()
	if err != nil {
		return Monitor{}, err
	}
	for _, m := range mons {
		if name == "" || m.Name == name || m.Device == name {
			return m, nil
		}
	}
	return Monitor{}, fmt.Errorf("no display named %q", name)
}

// MonitorOf is the display a window is mostly on.
func MonitorOf(hwnd windows.HWND) uintptr {
	h, _, _ := procMonitorFromWindow.Call(uintptr(hwnd), 2) // MONITOR_DEFAULTTONEAREST
	return h
}

// Window is a top-level application window.
type Window struct {
	HWND      windows.HWND
	Title     string
	App       string // its executable's name, without .exe
	Rect      Rect   // its visible bounds, without the drop shadow
	Minimized bool
	Pid       uint32
	Monitor   uintptr
}

// ID is a window's id for the daemon: its handle, in hex.
func ID(hwnd windows.HWND) string { return fmt.Sprintf("0x%x", uintptr(hwnd)) }

// ParseID reverses ID.
func ParseID(id string) (windows.HWND, error) {
	v, err := strconv.ParseUint(strings.TrimPrefix(id, "0x"), 16, 64)
	if err != nil || !strings.HasPrefix(id, "0x") {
		return 0, fmt.Errorf("bad window id %q", id)
	}
	return windows.HWND(v), nil
}

const (
	gwOwner         = 4
	gwlExStyle      = -20
	wsExToolWindow  = 0x80
	dwmaExtFrame    = 9
	dwmaCloaked     = 14
	swRestore       = 9
	errNotForegound = "the window didn't come to the front"
)

// Windows lists the windows Alt+Tab would, in z-order (frontmost first).
func Windows() ([]Window, error) {
	var out []Window
	cb := syscall.NewCallback(func(h windows.HWND, _ uintptr) uintptr {
		if w, ok := appWindow(h); ok {
			out = append(out, w)
		}
		return 1
	})
	if err := windows.EnumWindows(cb, nil); err != nil {
		return nil, fmt.Errorf("EnumWindows: %w", err)
	}
	return out, nil
}

func appWindow(h windows.HWND) (Window, bool) {
	if !windows.IsWindowVisible(h) {
		return Window{}, false
	}
	if owner, _, _ := procGetWindow.Call(uintptr(h), gwOwner); owner != 0 {
		return Window{}, false
	}
	idx := gwlExStyle // negative, so not a constant uintptr
	if ex, _, _ := procGetWindowLongPtrW.Call(uintptr(h), uintptr(idx)); ex&wsExToolWindow != 0 {
		return Window{}, false
	}
	var cloaked uint32
	if windows.DwmGetWindowAttribute(h, dwmaCloaked, unsafe.Pointer(&cloaked), 4) == nil && cloaked != 0 {
		return Window{}, false // on another virtual desktop, or a suspended app
	}
	title := windowText(h)
	if title == "" {
		return Window{}, false
	}
	if cls := className(h); cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" {
		return Window{}, false
	}
	w := Window{HWND: h, Title: title, Monitor: MonitorOf(h), Minimized: Minimized(h)}
	w.Rect, _ = Bounds(h)
	if w.Minimized {
		w.Rect = restoredRect(h, w.Rect)
	}
	if _, err := windows.GetWindowThreadProcessId(h, &w.Pid); err == nil {
		w.App = processName(w.Pid)
	}
	return w, true
}

// Bounds is a window's visible rectangle (without its drop shadow).
func Bounds(h windows.HWND) (Rect, error) {
	var r Rect
	if err := windows.DwmGetWindowAttribute(h, dwmaExtFrame, unsafe.Pointer(&r), uint32(unsafe.Sizeof(r))); err == nil {
		return r, nil
	}
	if ok, _, err := procGetWindowRect.Call(uintptr(h), uintptr(unsafe.Pointer(&r))); ok == 0 {
		return r, err
	}
	return r, nil
}

// restoredRect is where a minimized window goes back to (its own rectangle
// is parked at -32000).
func restoredRect(h windows.HWND, fallback Rect) Rect {
	var wp struct {
		Length, Flags, ShowCmd uint32
		MinPos, MaxPos         struct{ X, Y int32 }
		Normal                 Rect
	}
	wp.Length = uint32(unsafe.Sizeof(wp))
	if r, _, _ := procGetWindowPlacement.Call(uintptr(h), uintptr(unsafe.Pointer(&wp))); r == 0 {
		return fallback
	}
	return wp.Normal
}

// Alive reports whether h is still a window.
func Alive(h windows.HWND) bool { return windows.IsWindow(h) }

// Minimized reports whether h is minimized.
func Minimized(h windows.HWND) bool {
	r, _, _ := procIsIconic.Call(uintptr(h))
	return r != 0
}

func windowText(h windows.HWND) string {
	n, _, _ := procGetWindowTextLengthW.Call(uintptr(h))
	if n == 0 {
		return ""
	}
	buf := make([]uint16, n+1)
	procGetWindowTextW.Call(uintptr(h), uintptr(unsafe.Pointer(&buf[0])), n+1)
	return windows.UTF16ToString(buf)
}

func className(h windows.HWND) string {
	buf := make([]uint16, 256)
	n, err := windows.GetClassName(h, &buf[0], int32(len(buf)))
	if err != nil {
		return ""
	}
	return windows.UTF16ToString(buf[:n])
}

func processName(pid uint32) string {
	p, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(p)
	buf := make([]uint16, windows.MAX_PATH)
	n := uint32(len(buf))
	if windows.QueryFullProcessImageName(p, 0, &buf[0], &n) != nil {
		return ""
	}
	name := filepath.Base(windows.UTF16ToString(buf[:n]))
	return strings.TrimSuffix(name, filepath.Ext(name))
}

// Foreground is the window with keyboard focus.
func Foreground() windows.HWND { return windows.GetForegroundWindow() }

// Focus brings h to the front with keyboard focus, restoring it if it's
// minimized. Windows only lets the process the user last used take the
// foreground, so this borrows the foreground window's input queue.
func Focus(h windows.HWND) error {
	if !windows.IsWindow(h) {
		return errors.New("the window is gone")
	}
	if Minimized(h) {
		procShowWindow.Call(uintptr(h), swRestore)
	}
	if windows.GetForegroundWindow() == h {
		return nil
	}
	fg := windows.GetForegroundWindow()
	self := windows.GetCurrentThreadId()
	fgThread, _ := windows.GetWindowThreadProcessId(fg, nil)
	if fgThread != 0 && fgThread != self {
		procAttachThreadInput.Call(uintptr(self), uintptr(fgThread), 1)
		defer procAttachThreadInput.Call(uintptr(self), uintptr(fgThread), 0)
	}
	procBringWindowToTop.Call(uintptr(h))
	procSetForegroundWindow.Call(uintptr(h))
	for range 10 {
		if windows.GetForegroundWindow() == h {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return errors.New(errNotForegound)
}

// CursorPos is the pointer's position.
func CursorPos() (int32, int32) {
	var p struct{ X, Y int32 }
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&p)))
	return p.X, p.Y
}

// sysPointer turns an address Windows returned, of memory it owns, into a
// pointer. (Converting the uintptr directly would look to vet like a Go
// pointer escaping the garbage collector.)
func sysPointer(p uintptr) unsafe.Pointer { return *(*unsafe.Pointer)(unsafe.Pointer(&p)) }

// --- clipboard ----------------------------------------------------------------

const cfUnicodeText = 13

// ClipboardSequence changes whenever the clipboard does.
func ClipboardSequence() uint32 {
	r, _, _ := procGetClipboardSequenceNumber.Call()
	return uint32(r)
}

func openClipboard() error {
	var err error
	for range 10 { // another app may hold it for a moment
		var r uintptr
		if r, _, err = procOpenClipboard.Call(0); r != 0 {
			return nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	return fmt.Errorf("opening the clipboard: %w", err)
}

// ReadClipboard returns the clipboard's text; false when it holds none.
func ReadClipboard() (string, bool) {
	if openClipboard() != nil {
		return "", false
	}
	defer procCloseClipboard.Call()
	h, _, _ := procGetClipboardData.Call(cfUnicodeText)
	if h == 0 {
		return "", false
	}
	p, _, _ := procGlobalLock.Call(h)
	if p == 0 {
		return "", false
	}
	defer procGlobalUnlock.Call(h)
	return windows.UTF16PtrToString((*uint16)(sysPointer(p))), true
}

// WriteClipboard puts text on the clipboard.
func WriteClipboard(text string) error {
	u := utf16.Encode([]rune(text + "\x00"))
	if err := openClipboard(); err != nil {
		return err
	}
	defer procCloseClipboard.Call()
	procEmptyClipboard.Call()
	h, _, err := procGlobalAlloc.Call(0x2, uintptr(len(u)*2)) // GMEM_MOVEABLE
	if h == 0 {
		return fmt.Errorf("GlobalAlloc: %w", err)
	}
	p, _, _ := procGlobalLock.Call(h)
	copy(unsafe.Slice((*uint16)(sysPointer(p)), len(u)), u)
	procGlobalUnlock.Call(h)
	if r, _, err := procSetClipboardData.Call(cfUnicodeText, h); r == 0 {
		procGlobalFree.Call(h)
		return fmt.Errorf("SetClipboardData: %w", err)
	}
	return nil
}

// --- screenshots ----------------------------------------------------------------

type bitmapInfo struct {
	Size          uint32
	Width, Height int32
	Planes, Bits  uint16
	Compression   uint32
	SizeImage     uint32
	XPels, YPels  int32
	ClrUsed       uint32
	ClrImportant  uint32
	Colors        [1]uint32
}

// dib is a 32-bit top-down bitmap selected into a memory DC.
type dib struct {
	dc, bmp, old uintptr
	pix          []byte
	w, h         int
}

func newDIB(w, h int) (*dib, error) {
	dc, _, err := procCreateCompatibleDC.Call(0)
	if dc == 0 {
		return nil, fmt.Errorf("CreateCompatibleDC: %w", err)
	}
	bi := bitmapInfo{Width: int32(w), Height: -int32(h), Planes: 1, Bits: 32}
	bi.Size = 40
	var bits unsafe.Pointer
	bmp, _, err := procCreateDIBSection.Call(dc, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if bmp == 0 {
		procDeleteDC.Call(dc)
		return nil, fmt.Errorf("CreateDIBSection: %w", err)
	}
	old, _, _ := procSelectObject.Call(dc, bmp)
	return &dib{dc: dc, bmp: bmp, old: old, pix: unsafe.Slice((*byte)(bits), w*h*4), w: w, h: h}, nil
}

func (d *dib) free() {
	procSelectObject.Call(d.dc, d.old)
	procDeleteObject.Call(d.bmp)
	procDeleteDC.Call(d.dc)
}

// rgba copies the bitmap (BGRA) out as opaque RGBA.
func (d *dib) rgba() *image.RGBA {
	procGdiFlush.Call()
	img := image.NewRGBA(image.Rect(0, 0, d.w, d.h))
	for i := 0; i < len(d.pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = d.pix[i+2], d.pix[i+1], d.pix[i], 255
	}
	return img
}

// Screenshot copies a rectangle of the screen.
func Screenshot(r Rect) (*image.RGBA, error) {
	if r.Width() <= 0 || r.Height() <= 0 {
		return nil, errors.New("nothing to capture")
	}
	screen, _, _ := procGetDC.Call(0)
	if screen == 0 {
		return nil, errors.New("GetDC failed")
	}
	defer procReleaseDC.Call(0, screen)
	d, err := newDIB(r.Width(), r.Height())
	if err != nil {
		return nil, err
	}
	defer d.free()
	const srcCopyCaptureBlt = 0x00CC0020 | 0x40000000
	if ok, _, err := procBitBlt.Call(d.dc, 0, 0, uintptr(r.Width()), uintptr(r.Height()), screen, uintptr(r.Left), uintptr(r.Top), srcCopyCaptureBlt); ok == 0 {
		return nil, fmt.Errorf("BitBlt: %w (is the screen locked?)", err)
	}
	return d.rgba(), nil
}

// WindowScreenshot renders a window, even one covered by others, cropped to
// its visible bounds.
func WindowScreenshot(h windows.HWND) (*image.RGBA, error) {
	if Minimized(h) {
		return nil, errors.New("the window is minimized")
	}
	var full Rect
	if ok, _, err := procGetWindowRect.Call(uintptr(h), uintptr(unsafe.Pointer(&full))); ok == 0 {
		return nil, fmt.Errorf("GetWindowRect: %w", err)
	}
	vis, err := Bounds(h)
	if err != nil {
		return nil, err
	}
	d, err := newDIB(full.Width(), full.Height())
	if err != nil {
		return nil, err
	}
	defer d.free()
	const pwRenderFullContent = 2
	if ok, _, err := procPrintWindow.Call(uintptr(h), d.dc, pwRenderFullContent); ok == 0 {
		return nil, fmt.Errorf("PrintWindow: %w", err)
	}
	img := d.rgba()
	crop := image.Rect(int(vis.Left-full.Left), int(vis.Top-full.Top), int(vis.Right-full.Left), int(vis.Bottom-full.Top)).Intersect(img.Rect)
	// A compact copy: callers take Pix as tightly packed rows.
	out := image.NewRGBA(image.Rect(0, 0, crop.Dx(), crop.Dy()))
	for y := range crop.Dy() {
		copy(out.Pix[y*out.Stride:(y+1)*out.Stride], img.Pix[(crop.Min.Y+y)*img.Stride+crop.Min.X*4:])
	}
	return out, nil
}

// VirtualScreen is the rectangle spanning every display.
func VirtualScreen() Rect {
	m := func(i uintptr) int32 { r, _, _ := procGetSystemMetrics.Call(i); return int32(r) }
	x, y := m(76), m(77) // SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN
	return Rect{x, y, x + m(78), y + m(79)}
}
