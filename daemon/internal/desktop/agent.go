package desktop

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
)

// An agent's worker closes once its tools haven't been used for this long.
const agentIdle = 2 * time.Minute

// ScreenshotMaxSide bounds an agent's screenshots, which go into the model's
// context; its coordinates are pixels of such a screenshot.
const ScreenshotMaxSide = 1280

// Agent is one thread's hands on a desktop, for its AI tools: a target (a
// monitor or one window) and a worker that takes screenshots of it and
// injects input there. It runs beside a viewer's session, with its own
// virtual pointer and keyboard, so someone can watch it work.
//
// It works on Claude's desktop (claudedesk.go) unless told to use the user's:
// there, its pointer and keyboard focus are the user's own.
type Agent struct {
	m   *Manager
	key string

	mu               sync.Mutex // one tool call at a time
	desk             string     // deskClaude or deskYours
	src              source     // Output "" until first used: then the focused monitor
	w                *worker
	wSig, wOut, wWin string // what w was started for
	idle             *time.Timer
}

// The desktops an agent can work on.
const (
	deskClaude = "claude" // Claude's own, beside the user's
	deskYours  = "yours"  // the user's, with their pointer and focus
)

// defaultDesk is where agents start: Claude's desktop where there is one.
var defaultDesk = deskClaude

// Agent returns the desktop agent of a thread (key), making it if needed.
func (m *Manager) Agent(key string) (*Agent, error) {
	if !m.enabled() {
		return nil, ErrDisabled
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.agents == nil {
		m.agents = map[string]*Agent{}
	}
	a := m.agents[key]
	if a == nil {
		a = &Agent{m: m, key: key, desk: defaultDesk}
		m.agents[key] = a
	}
	return a, nil
}

// CloseAgent stops a thread's desktop agent; its thread is gone.
func (m *Manager) CloseAgent(key string) {
	m.mu.Lock()
	a := m.agents[key]
	delete(m.agents, key)
	m.mu.Unlock()
	if a != nil {
		a.mu.Lock()
		a.stopWorker()
		a.mu.Unlock()
	}
}

func (m *Manager) closeAgents() {
	m.mu.Lock()
	agents := m.agents
	m.agents = nil
	m.mu.Unlock()
	for _, a := range agents {
		a.mu.Lock()
		a.stopWorker()
		a.mu.Unlock()
	}
}

// View is where an agent's target is now, and the size of its screenshots.
type View struct {
	h      desktopHost
	mon    deskMonitor
	win    *windowGeom // nil for a monitor
	src    source
	Target Target
	// Width and Height are the screenshot's size: the coordinate space of
	// the agent's pointer.
	Width, Height int
}

// Target describes what an agent sees and acts on.
type Target struct {
	Desktop string `json:"desktop"` // claude | yours
	Kind    string `json:"kind"`    // monitor | window
	Monitor string `json:"monitor"`
	Window  string `json:"window,omitempty"` // stableId
	Class   string `json:"class,omitempty"`
	Title   string `json:"title,omitempty"`
	// NativeWidth and NativeHeight are its size in physical pixels.
	NativeWidth  int `json:"nativeWidth"`
	NativeHeight int `json:"nativeHeight"`
}

// host is the desktop the agent works on, starting Claude's if needed. Must
// hold a.mu.
func (a *Agent) host() (desktopHost, error) {
	if a.desk == deskYours {
		return findDesktop()
	}
	return a.m.claude.instance()
}

// desktop is the desktop the agent works on, for tools that act on it rather
// than its target.
func (a *Agent) desktop() (desktopHost, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.host()
}

// resolve finds the target on the desktop as it is now. Must hold a.mu.
func (a *Agent) resolve() (*View, error) {
	h, err := a.host()
	if err != nil {
		return nil, err
	}
	mons, err := h.monitors()
	if err != nil {
		return nil, err
	}
	v := &View{h: h}
	var nw, nh int
	if a.src.Window != "" || a.src.Class != "" {
		clients, err := h.clients()
		if err != nil {
			return nil, err
		}
		c := resolveWindow(clients, a.src)
		if c == nil {
			return nil, errors.New("the window is gone; find another with desktop_list and open it with desktop_open")
		}
		mon, ok := monitorByID(mons, c.Monitor)
		if !ok {
			return nil, fmt.Errorf("the window's monitor (%d) is gone", c.Monitor)
		}
		v.mon, v.win = mon, newWindowGeom(c, mon)
		// Follow the window by its current id (the app may have restarted).
		a.src = source{Window: c.StableID, Class: c.Class, Title: c.Title}
		scale := mon.Scale
		if scale <= 0 {
			scale = 1
		}
		nw, nh = int(math.Round(float64(c.Size[0])*scale)), int(math.Round(float64(c.Size[1])*scale))
		v.Target = Target{Kind: "window", Monitor: mon.Name, Window: c.StableID, Class: c.Class, Title: c.Title}
	} else {
		name := a.src.Output
		if name == "" {
			name = focusedOutput(mons)
		}
		mon, ok := resolveOutput(name, mons)
		if !ok {
			return nil, fmt.Errorf("no monitor named %q; see desktop_list", name)
		}
		v.mon = mon
		a.src = source{Output: mon.Name}
		nw, nh = mon.Width, mon.Height
		v.Target = Target{Kind: "monitor", Monitor: mon.Name}
	}
	v.src = a.src
	v.Target.Desktop = a.desk
	v.Target.NativeWidth, v.Target.NativeHeight = nw, nh
	v.Width, v.Height = fit(nw, nh, ScreenshotMaxSide)
	return v, nil
}

// fit scales w×h down so its longer side is at most limit.
func fit(w, h, limit int) (int, int) {
	if w <= limit && h <= limit {
		return w, h
	}
	if w >= h {
		return limit, max(1, int(math.Round(float64(h)*float64(limit)/float64(w))))
	}
	return max(1, int(math.Round(float64(w)*float64(limit)/float64(h)))), limit
}

// worker returns a worker for v's target, starting it if needed. Must hold a.mu.
func (a *Agent) worker(v *View) (*worker, error) {
	win := v.src.Window
	if a.w != nil && (a.wSig != v.h.key() || a.wOut != v.mon.Name || a.wWin != win || !a.w.alive()) {
		a.stopWorker()
	}
	if a.w == nil {
		w, err := startWorker(ipc.Config{Agent: true, Output: v.mon.Name, Window: win, Input: true, Keymap: v.h.keymap()}, v.h.env())
		if err != nil {
			return nil, err
		}
		if msg := w.InputError(); msg != "" {
			slog.Warn("desktop agent input unavailable; screenshots only", "thread", a.key, "err", msg)
		}
		a.w, a.wSig, a.wOut, a.wWin = w, v.h.key(), v.mon.Name, win
	}
	if a.idle == nil {
		a.idle = time.AfterFunc(agentIdle, a.expire)
	} else {
		a.idle.Reset(agentIdle)
	}
	return a.w, nil
}

func (a *Agent) expire() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.stopWorker()
}

// stopWorker must hold a.mu.
func (a *Agent) stopWorker() {
	if a.idle != nil {
		a.idle.Stop()
		a.idle = nil
	}
	if a.w != nil {
		a.w.ReleaseAll()
		a.w.Free()
		a.w = nil
	}
}

func (w *worker) alive() bool {
	select {
	case <-w.closeCh:
		return false
	default:
		return true
	}
}

// Open points the agent at a desktop ("" for the one it's on), and there at a
// window (by stableId) or a monitor ("" for the focused one).
func (a *Agent) Open(desk, window, output string) (*View, error) {
	switch desk {
	case "", deskClaude, deskYours:
	default:
		return nil, fmt.Errorf("unknown desktop %q: use %q or %q", desk, deskClaude, deskYours)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	prev, prevDesk := a.src, a.desk
	if desk != "" {
		a.desk = desk
	}
	if window != "" {
		a.src = source{Window: window}
	} else {
		a.src = source{Output: output}
	}
	v, err := a.resolve()
	if err != nil {
		a.src, a.desk = prev, prevDesk
		return nil, err
	}
	return v, nil
}

// Current is the agent's target now.
func (a *Agent) Current() (*View, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.resolve()
}

// Shot is an agent's screenshot, JPEG at the view's size.
type Shot struct {
	JPEG []byte
	View *View
	// Path is the full-resolution PNG, when asked to save one.
	Path string
}

// Screenshot captures the target. save also writes a full-resolution PNG.
func (a *Agent) Screenshot(save bool) (*Shot, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.screenshot(save)
}

func (a *Agent) screenshot(save bool) (*Shot, error) {
	v, err := a.resolve()
	if err != nil {
		return nil, err
	}
	w, err := a.worker(v)
	if err != nil {
		return nil, err
	}
	img, err := w.Still()
	if err != nil {
		return nil, err
	}
	shot := &Shot{View: v}
	if save {
		if shot.Path, err = a.m.saveScreenshot(img); err != nil {
			return nil, fmt.Errorf("saving the screenshot: %w", err)
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, shrink(img, v.Width, v.Height), &jpeg.Options{Quality: 80}); err != nil {
		return nil, err
	}
	shot.JPEG = buf.Bytes()
	return shot, nil
}

func (m *Manager) saveScreenshot(img image.Image) (string, error) {
	if m.ArtifactsDir == "" {
		return "", errors.New("nowhere to save screenshots")
	}
	if err := os.MkdirAll(m.ArtifactsDir, 0o700); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(m.ArtifactsDir, "desktop-"+time.Now().Format("20060102-150405")+"-*.png")
	if err != nil {
		return "", err
	}
	if err := png.Encode(f, img); err != nil {
		f.Close()
		os.Remove(f.Name())
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	return filepath.Abs(f.Name())
}

// shrink scales img to w×h by averaging the source pixels under each one.
func shrink(img *image.RGBA, w, h int) *image.RGBA {
	sw, sh := img.Rect.Dx(), img.Rect.Dy()
	if w >= sw && h >= sh {
		return img
	}
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		y0, y1 := y*sh/h, max((y+1)*sh/h, y*sh/h+1)
		for x := range w {
			x0, x1 := x*sw/w, max((x+1)*sw/w, x*sw/w+1)
			var r, g, b, n int
			for sy := y0; sy < y1; sy++ {
				row := img.Pix[sy*img.Stride:]
				for sx := x0; sx < x1; sx++ {
					p := row[sx*4:]
					r, g, b, n = r+int(p[0]), g+int(p[1]), b+int(p[2]), n+1
				}
			}
			o := out.Pix[y*out.Stride+x*4:]
			o[0], o[1], o[2], o[3] = uint8(r/n), uint8(g/n), uint8(b/n), 255
		}
	}
	return out
}

// Point is a position in an agent's screenshot, in its pixels.
type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// pointer maps p to the virtual pointer's range (0..65535 across the
// monitor) and to layout coordinates, for showing viewers where it acted.
func (v *View) pointer(p Point) (px, py uint16, lx, ly float64, err error) {
	if p.X < 0 || p.Y < 0 || p.X >= float64(v.Width) || p.Y >= float64(v.Height) {
		return 0, 0, 0, 0, fmt.Errorf("(%g, %g) is outside the %d×%d screenshot", p.X, p.Y, v.Width, v.Height)
	}
	nx, ny := (p.X+0.5)/float64(v.Width), (p.Y+0.5)/float64(v.Height)
	if v.win != nil {
		lx = float64(v.win.At[0]) + nx*float64(v.win.Size[0])
		ly = float64(v.win.At[1]) + ny*float64(v.win.Size[1])
		px, py = v.win.toMonitor(uint16(nx*65535), uint16(ny*65535))
		return px, py, lx, ly, nil
	}
	lx = float64(v.mon.X) + nx*float64(v.mon.Width)/monScale(v.mon)
	ly = float64(v.mon.Y) + ny*float64(v.mon.Height)/monScale(v.mon)
	return uint16(nx * 65535), uint16(ny * 65535), lx, ly, nil
}

func monScale(m deskMonitor) float64 {
	if m.Scale <= 0 {
		return 1
	}
	return m.Scale
}

// input readies the target for input: the worker, and for a window,
// keyboard focus (which shows its workspace). Must hold a.mu.
func (a *Agent) input() (*worker, *View, error) {
	v, err := a.resolve()
	if err != nil {
		return nil, nil, err
	}
	w, err := a.worker(v)
	if err != nil {
		return nil, nil, err
	}
	if msg := w.InputError(); msg != "" {
		return nil, nil, fmt.Errorf("input isn't available on this desktop: %s", msg)
	}
	if v.win != nil && v.h.activeWindow() != v.win.Address {
		if err := v.h.focusAddress(v.win.Address); err != nil {
			return nil, nil, fmt.Errorf("focusing the window: %w", err)
		}
		time.Sleep(50 * time.Millisecond) // let the workspace switch land
	}
	return w, v, nil
}

var agentButtons = map[string]uint32{"": btnLeft, "left": btnLeft, "right": btnRight, "middle": btnMiddle, "back": btnSide, "forward": btnExtra}

// Click clicks p count times (2 for a double click) with button.
func (a *Agent) Click(p Point, button string, count int) error {
	code, ok := agentButtons[button]
	if !ok {
		return fmt.Errorf("unknown button %q", button)
	}
	count = min(max(count, 1), 3)
	a.mu.Lock()
	defer a.mu.Unlock()
	w, v, err := a.input()
	if err != nil {
		return err
	}
	px, py, lx, ly, err := v.pointer(p)
	if err != nil {
		return err
	}
	w.Motion(px, py)
	for i := range count {
		if i > 0 {
			time.Sleep(40 * time.Millisecond)
		}
		w.Button(code, true, px, py)
		w.Button(code, false, px, py)
	}
	action := "click"
	if count == 2 {
		action = "double-click"
	}
	a.m.agentActed(v.h, action, lx, ly, "")
	return nil
}

// Move moves the pointer to p, for hovering.
func (a *Agent) Move(p Point) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	w, v, err := a.input()
	if err != nil {
		return err
	}
	px, py, lx, ly, err := v.pointer(p)
	if err != nil {
		return err
	}
	w.Motion(px, py)
	a.m.agentActed(v.h, "move", lx, ly, "")
	return nil
}

// Drag presses button at from, moves to to in steps, and releases it.
func (a *Agent) Drag(from, to Point, button string) error {
	code, ok := agentButtons[button]
	if !ok {
		return fmt.Errorf("unknown button %q", button)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	w, v, err := a.input()
	if err != nil {
		return err
	}
	fx, fy, _, _, err := v.pointer(from)
	if err != nil {
		return err
	}
	_, _, lx, ly, err := v.pointer(to)
	if err != nil {
		return err
	}
	w.Motion(fx, fy)
	w.Button(code, true, fx, fy)
	const steps = 12
	for i := 1; i <= steps; i++ {
		time.Sleep(16 * time.Millisecond)
		t := float64(i) / steps
		px, py, _, _, _ := v.pointer(Point{from.X + (to.X-from.X)*t, from.Y + (to.Y-from.Y)*t})
		w.Motion(px, py)
	}
	tx, ty, _, _, _ := v.pointer(to)
	w.Button(code, false, tx, ty)
	a.m.agentActed(v.h, "drag", lx, ly, "")
	return nil
}

// Scroll moves the pointer to p and turns the wheel: dy notches down (up if
// negative), dx right.
func (a *Agent) Scroll(p Point, dx, dy float64) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	w, v, err := a.input()
	if err != nil {
		return err
	}
	px, py, lx, ly, err := v.pointer(p)
	if err != nil {
		return err
	}
	w.Motion(px, py)
	w.Scroll(false, dx, dy)
	a.m.agentActed(v.h, "scroll", lx, ly, "")
	return nil
}

// Type types text with the keyboard layout's keys. It stops at a character
// the layout can't type, reporting how many it typed.
func (a *Agent) Type(text string) (int, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	w, v, err := a.input()
	if err != nil {
		return 0, err
	}
	n := 0
	for _, r := range text {
		ok, err := w.Type(r)
		if err != nil {
			return n, err
		}
		if !ok {
			return n, fmt.Errorf("the keyboard layout has no key for %q (typed the %d characters before it); put the text on the clipboard with desktop_clipboard and paste it instead", r, n)
		}
		n++
	}
	a.m.agentActed(v.h, "type", math.NaN(), math.NaN(), truncate(text, 40))
	return n, nil
}

// Press presses a key combination like "ctrl+shift+t", times times.
func (a *Agent) Press(combo string, times int) error {
	keys, err := parseCombo(combo)
	if err != nil {
		return err
	}
	times = min(max(times, 1), 50)
	a.mu.Lock()
	defer a.mu.Unlock()
	w, v, err := a.input()
	if err != nil {
		return err
	}
	for range times {
		for _, k := range keys {
			w.Key(k, true)
		}
		for i := len(keys) - 1; i >= 0; i-- {
			w.Key(keys[i], false)
		}
		time.Sleep(20 * time.Millisecond)
	}
	a.m.agentActed(v.h, "key", math.NaN(), math.NaN(), combo)
	return nil
}

// FocusWorkspace shows a workspace.
func (a *Agent) FocusWorkspace(id int) error {
	if id < 1 || id > 9999 {
		return fmt.Errorf("workspace %d is out of range", id)
	}
	h, err := a.desktop()
	if err != nil {
		return err
	}
	return h.showWorkspace(int32(id))
}

// FocusWindow focuses a window (by stableId), showing its workspace.
func (a *Agent) FocusWindow(id string) error {
	h, err := a.desktop()
	if err != nil {
		return err
	}
	clients, err := h.clients()
	if err != nil {
		return err
	}
	c := resolveWindow(clients, source{Window: id})
	if c == nil {
		return fmt.Errorf("no window %q; see desktop_list", id)
	}
	return h.focusAddress(c.Address)
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

// Desktop lists the monitors, workspaces and windows.
type Desktop struct {
	Monitors   []MonitorInfo   `json:"monitors"`
	Workspaces []WorkspaceInfo `json:"workspaces"`
	Windows    []WindowInfo    `json:"windows"`
}

type MonitorInfo struct {
	Name            string  `json:"name"`
	Width           int     `json:"width"`
	Height          int     `json:"height"`
	Scale           float64 `json:"scale"`
	Focused         bool    `json:"focused"`
	ActiveWorkspace int     `json:"activeWorkspace"`
}

type WorkspaceInfo struct {
	ID      int    `json:"id"`
	Name    string `json:"name"`
	Monitor string `json:"monitor"`
	Windows int    `json:"windows"`
	Shown   bool   `json:"shown"`
}

type WindowInfo struct {
	ID        string `json:"id"` // stableId
	Class     string `json:"class"`
	Title     string `json:"title"`
	Workspace string `json:"workspace"`
	Monitor   string `json:"monitor"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Focused   bool   `json:"focused,omitempty"`
	Floating  bool   `json:"floating,omitempty"`
}

// List describes the desktop.
func (a *Agent) List() (*Desktop, error) {
	h, err := a.desktop()
	if err != nil {
		return nil, err
	}
	mons, err := h.monitors()
	if err != nil {
		return nil, err
	}
	wss, err := h.workspaces()
	if err != nil {
		return nil, err
	}
	clients, err := h.clients()
	if err != nil {
		return nil, err
	}
	active := h.activeWindow()
	d := &Desktop{Monitors: []MonitorInfo{}, Workspaces: []WorkspaceInfo{}, Windows: []WindowInfo{}}
	shown := map[int]bool{}
	for _, m := range mons {
		if m.Disabled {
			continue
		}
		shown[m.ActiveWorkspace.ID] = true
		d.Monitors = append(d.Monitors, MonitorInfo{Name: m.Name, Width: m.Width, Height: m.Height, Scale: m.Scale, Focused: m.Focused, ActiveWorkspace: m.ActiveWorkspace.ID})
	}
	for _, w := range wss {
		if w.ID > 0 {
			d.Workspaces = append(d.Workspaces, WorkspaceInfo{ID: w.ID, Name: w.Name, Monitor: w.Monitor, Windows: w.Windows, Shown: shown[w.ID]})
		}
	}
	for _, info := range windowInfos(clients, mons, active) {
		for _, c := range clients {
			if c.StableID == info.ID {
				d.Windows = append(d.Windows, WindowInfo{
					ID: info.ID, Class: info.Class, Title: info.Title, Workspace: info.Workspace, Monitor: info.Monitor,
					Width: c.Size[0], Height: c.Size[1], Focused: info.Focused, Floating: c.Floating,
				})
				break
			}
		}
	}
	return d, nil
}

// Clipboard reads the desktop's clipboard text.
func (a *Agent) Clipboard() (string, error) {
	h, err := a.desktop()
	if err != nil {
		return "", err
	}
	text, ok := h.readClipboard(context.Background())
	if !ok {
		return "", errors.New("the clipboard holds no text")
	}
	return text, nil
}

// SetClipboard puts text on the desktop's clipboard.
func (a *Agent) SetClipboard(text string) error {
	h, err := a.desktop()
	if err != nil {
		return err
	}
	return writeClipboardText(h, text)
}

// keyNames are the key names a combination can use, as linux KEY_* codes.
// Letters, digits and punctuation are the US layout's positions.
var keyNames = map[string]uint32{
	"esc": 1, "escape": 1, "minus": 12, "-": 12, "equal": 13, "=": 13, "backspace": 14, "tab": 15,
	"[": 26, "bracketleft": 26, "]": 27, "bracketright": 27, "enter": 28, "return": 28,
	"ctrl": 29, "control": 29, "lctrl": 29, ";": 39, "semicolon": 39, "'": 40, "apostrophe": 40,
	"`": 41, "grave": 41, "shift": 42, "lshift": 42, "\\": 43, "backslash": 43,
	",": 51, "comma": 51, ".": 52, "period": 52, "/": 53, "slash": 53, "rshift": 54,
	"alt": 56, "lalt": 56, "space": 57, "capslock": 58, "numlock": 69, "scrolllock": 70,
	"rctrl": 97, "print": 99, "printscreen": 99, "altgr": 100, "ralt": 100,
	"home": 102, "up": 103, "pageup": 104, "left": 105, "right": 106, "end": 107, "down": 108,
	"pagedown": 109, "insert": 110, "delete": 111, "del": 111,
	"mute": 113, "volumedown": 114, "volumeup": 115, "pause": 119,
	"super": 125, "meta": 125, "win": 125, "cmd": 125, "lsuper": 125, "rsuper": 126, "menu": 127,
	"nextsong": 163, "playpause": 164, "previoussong": 165,
	"brightnessdown": 224, "brightnessup": 225,
}

func init() {
	for i, c := range "1234567890" {
		keyNames[string(c)] = uint32(2 + i)
	}
	for i, row := range []string{"qwertyuiop", "asdfghjkl", "zxcvbnm"} {
		start := []uint32{16, 30, 44}[i]
		for j, c := range row {
			keyNames[string(c)] = start + uint32(j)
		}
	}
	for i := 1; i <= 10; i++ {
		keyNames[fmt.Sprintf("f%d", i)] = uint32(58 + i)
	}
	keyNames["f11"], keyNames["f12"] = 87, 88
	for i := 13; i <= 24; i++ {
		keyNames[fmt.Sprintf("f%d", i)] = uint32(170 + i)
	}
}

// parseCombo turns "ctrl+shift+t" into its keys, in pressing order.
func parseCombo(combo string) ([]uint32, error) {
	combo = strings.TrimSpace(combo)
	if combo == "" {
		return nil, errors.New("no keys given")
	}
	var parts []string
	if combo == "+" {
		parts = []string{"shift", "="}
	} else {
		parts = strings.Split(combo, "+")
	}
	keys := make([]uint32, 0, len(parts))
	for _, p := range parts {
		name := strings.ToLower(strings.TrimSpace(p))
		code, ok := keyNames[name]
		if !ok {
			return nil, fmt.Errorf("unknown key %q in %q", p, combo)
		}
		keys = append(keys, code)
	}
	return keys, nil
}

// How long desktop_launch waits for the app's window.
const launchWait = 8 * time.Second

// Launch starts command on Claude's desktop (the user's where there's no
// Claude's desktop), which becomes the target, and waits a little for a new
// window. The window is nil if none appeared.
func (a *Agent) Launch(command string) (*WindowInfo, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil, errors.New("no command given")
	}
	if strings.ContainsAny(command, "\r\n\x00") {
		return nil, errors.New("give the command on one line")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	desk, src := deskClaude, source{Output: claudeOutput}
	if defaultDesk == deskYours {
		desk, src = deskYours, source{}
	}
	var h desktopHost
	var err error
	if desk == deskClaude {
		h, err = a.m.claude.instance()
	} else {
		h, err = findDesktop()
	}
	if err != nil {
		return nil, err
	}
	before, err := h.clients()
	if err != nil {
		return nil, err
	}
	if err := h.launch(command); err != nil {
		return nil, err
	}
	a.desk, a.src = desk, src
	known := map[string]bool{}
	for _, c := range before {
		known[c.Address] = true
	}
	for deadline := time.Now().Add(launchWait); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		clients, err := h.clients()
		if err != nil {
			return nil, err
		}
		for _, c := range clients {
			if c.Mapped && !known[c.Address] {
				mons, _ := h.monitors()
				mon, _ := monitorByID(mons, c.Monitor)
				return &WindowInfo{ID: c.StableID, Class: c.Class, Title: c.Title, Workspace: c.Workspace.Name,
					Monitor: mon.Name, Width: c.Size[0], Height: c.Size[1], Floating: c.Floating}, nil
			}
		}
	}
	return nil, nil
}
