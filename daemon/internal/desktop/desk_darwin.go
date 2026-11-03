package desktop

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
)

// On macOS the desktop is the logged-in user's, which the daemon runs beside
// (it's a LaunchAgent in their GUI session). As on Windows there's no
// Claude's desktop, so agents use the user's. Spaces have no public API, so
// there are no workspaces. Monitors are in Hyprland's terms: a position in
// points, a size in pixels and a scale; windows are in points.
//
// The daemon stays CGO-free: what needs macOS's frameworks and permissions
// (window titles, focusing windows, the clipboard) is asked of
// EverywhereDesktop.app in host mode, which keeps running while the daemon
// uses the desktop.

func init() { defaultDesk = deskYours }

// macDesk explains the one desktop, for the tools that pick one.
const macDesk = "This is the user's own Mac desktop (\"yours\"; there's no separate Claude's desktop on macOS): acting moves their mouse pointer and takes their keyboard focus, and they can watch in the thread's Desktop tab."

// descriptionOverrides fits the tools' descriptions to macOS: one desktop,
// no workspaces, Mac apps and shortcuts.
var descriptionOverrides = map[string]string{
	"desktop_list":       "List the user's Mac desktop: monitors (name like \"Built-in Retina Display\", size in pixels, focused) and windows (id, app, title, monitor, size), frontmost first; hidden ones are minimized or in another Space. There are no workspaces. Also says what this thread's target is: the window or monitor that desktop_screenshot shows and the input tools act on.",
	"desktop_open":       "Point this thread at one window (by id from desktop_list) or one monitor (by name; neither means the focused monitor). desktop_screenshot then shows it and the input tools act on it; the user sees it in the thread's Desktop tab. A window stays the target when it moves; acting on it brings it to the front. " + macDesk + " Returns a screenshot.",
	"desktop_launch":     "Open an app on the user's Mac by name, e.g. \"TextEdit\", \"Safari\" or \"Visual Studio Code\" (as `open -a` would), or a URL or file path in its default app, and make the focused monitor this thread's target. It waits a few seconds for the app's window and returns it with a screenshot; open it with desktop_open to act on just that window. For web pages, the browser_* tools are usually better. " + macDesk,
	"desktop_screenshot": "Take a screenshot of this thread's target window or monitor (see desktop_open; by default the focused monitor), scaled to at most 1280px. Its pixels are the coordinates for desktop_click and the other input tools. A window is captured even when it's behind others, but not while it's minimized. Set save=true to also save a full-resolution PNG and get its path; to show the user, put ![description](path) in your reply. The image in the tool result itself is not shown to the user.",
	"desktop_focus":      "Bring a window (by id from desktop_list) to the front with keyboard focus, restoring it if it's minimized and switching to its Space. It doesn't change this thread's target; use desktop_open for that.",
	"desktop_press":      "Press a key or key combination in this thread's target (a window target is focused first), like \"enter\", \"cmd+c\", \"cmd+shift+t\", \"cmd+tab\" or \"ctrl+left\". Names: cmd (or command, super), ctrl, shift, option (or alt), enter, esc, tab, space, backspace, delete (forward delete), home, end, pageup, pagedown, up, down, left, right, f1-f20, capslock, volumeup, volumedown, mute, letters, digits and US-layout punctuation (keys are pressed by position). Mac shortcuts use cmd where other systems use ctrl.",
}

type macHost struct {
	mu   sync.Mutex // one request at a time
	conn *hostConn

	watchMu  sync.Mutex
	watchers map[*func()]struct{}
}

// theMac is the one desktop; its helper starts on first use.
var theMac = &macHost{watchers: map[*func()]struct{}{}}

// findDesktop finds the user's desktop: the GUI session the daemon runs in.
func findDesktop() (desktopHost, error) {
	if os.Geteuid() == 0 {
		return nil, errors.New("the daemon runs as root, outside your login session; install it as yourself (`everywhere service install`) for remote desktop")
	}
	return theMac, nil
}

// hostConn is a connection to the app in host mode.
type hostConn struct {
	c       *net.UnixConn
	replies chan []byte
	done    chan struct{}
}

// request asks the helper op and decodes its result into out.
func (h *macHost) request(op string, args map[string]any, out any) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	hc, err := h.connect()
	if err != nil {
		return err
	}
	req := map[string]any{"op": op}
	for k, v := range args {
		req[k] = v
	}
	b, _ := json.Marshal(req)
	if err := ipc.WriteMsg(hc.c, ipc.MsgRequest, b); err != nil {
		hc.c.Close()
		return fmt.Errorf("desktop helper: %w", err)
	}
	var payload []byte
	select {
	case payload = <-hc.replies:
	case <-hc.done:
		return errors.New("desktop helper exited")
	case <-time.After(10 * time.Second):
		hc.c.Close()
		return errors.New("desktop helper stopped responding")
	}
	var r struct {
		Result json.RawMessage
		Error  string
	}
	if err := json.Unmarshal(payload, &r); err != nil {
		return fmt.Errorf("desktop helper: %w", err)
	}
	if r.Error != "" {
		return errors.New(r.Error)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(r.Result, out)
}

// connect starts the helper if it isn't running. Must hold h.mu.
func (h *macHost) connect() (*hostConn, error) {
	if h.conn != nil {
		select {
		case <-h.conn.done:
		default:
			return h.conn, nil
		}
	}
	app, err := helperPath()
	if err != nil {
		return nil, err
	}
	c, err := launchHelper(app, ipc.HostArg)
	if err != nil {
		return nil, err
	}
	r := bufio.NewReader(c)
	typ, payload, err := ipc.ReadMsg(r)
	if err != nil || typ != ipc.MsgHello {
		c.Close()
		return nil, fmt.Errorf("desktop helper: no hello (%v)", err)
	}
	var hello struct {
		ipc.Hello
		ScreenRecording, Accessibility bool
	}
	if err := json.Unmarshal(payload, &hello); err != nil || hello.Version != ipc.Version {
		c.Close()
		return nil, fmt.Errorf("%s doesn't match this daemon (protocol %d, want %d); run `everywhere update`", HelperName, hello.Version, ipc.Version)
	}
	if !hello.ScreenRecording || !hello.Accessibility {
		slog.Warn("remote desktop permissions missing; run `everywhere desktop enable` on the Mac",
			"screenRecording", hello.ScreenRecording, "accessibility", hello.Accessibility)
	}
	hc := &hostConn{c: c, replies: make(chan []byte, 1), done: make(chan struct{})}
	go h.read(hc, r)
	h.conn = hc
	return hc, nil
}

func (h *macHost) read(hc *hostConn, r *bufio.Reader) {
	defer close(hc.done)
	defer hc.c.Close()
	for {
		typ, payload, err := ipc.ReadMsg(r)
		if err != nil {
			return
		}
		switch typ {
		case ipc.MsgReply:
			select {
			case hc.replies <- payload:
			default: // nobody's waiting: it timed out
			}
		case ipc.MsgEvent:
			h.watchMu.Lock()
			for f := range h.watchers {
				go (*f)()
			}
			h.watchMu.Unlock()
		}
	}
}

func (*macHost) key() string    { return "mac" }
func (*macHost) isClaude() bool { return false }

func (h *macHost) monitors() ([]deskMonitor, error) {
	var mons []deskMonitor
	return mons, h.request("monitors", nil, &mons)
}

func (*macHost) workspaces() ([]deskWorkspace, error) { return nil, nil }

type macWindows struct {
	Windows []deskWindow
	Active  string
}

func (h *macHost) clients() ([]deskWindow, error) {
	var ws macWindows
	return ws.Windows, h.request("windows", nil, &ws)
}

func (h *macHost) activeWindow() string {
	var ws macWindows
	if err := h.request("windows", nil, &ws); err != nil {
		return ""
	}
	return ws.Active
}

func (h *macHost) focusAddress(address string) error {
	return h.request("focus", map[string]any{"id": address}, nil)
}

func (*macHost) showWorkspace(int32) error {
	return errors.New("macOS Spaces can't be switched by other apps; focus a window in that Space instead")
}

// focusOutput does nothing: macOS gives windows focus, not monitors.
func (*macHost) focusOutput(string) error { return nil }

// launch opens an app by name (as `open -a` does), or a URL or path in its
// default app.
func (*macHost) launch(command string) error {
	command = strings.TrimSpace(command)
	var cmd *exec.Cmd
	switch {
	case strings.Contains(command, "://"), strings.HasPrefix(command, "/"), strings.HasPrefix(command, "~"):
		cmd = exec.Command("open", command)
	default:
		cmd = exec.Command("open", "-a", command)
	}
	out, err := cmd.CombinedOutput()
	if err != nil && strings.Contains(command, " ") && !strings.Contains(command, "://") {
		// "App args...": the first word is the app.
		name, rest, _ := strings.Cut(command, " ")
		out, err = exec.Command("open", append([]string{"-a", name, "--args"}, strings.Fields(rest)...)...).CombinedOutput()
	}
	if err != nil {
		return fmt.Errorf("opening %q: %w %s", command, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// changes: macOS tells other apps little about windows; the session polls.
func (*macHost) changes(<-chan struct{}) (<-chan struct{}, error) { return nil, nil }

func (*macHost) env() []string      { return os.Environ() }
func (*macHost) keymap() ipc.Keymap { return ipc.Keymap{} }

// notify shows a notification through AppleScript, which needs no app
// identity of its own.
func (*macHost) notify(summary, body string) {
	q := func(s string) string { return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"` }
	go func() {
		script := "display notification " + q(body) + " with title " + q("Everywhere") + " subtitle " + q(summary)
		if out, err := exec.Command("osascript", "-e", script).CombinedOutput(); err != nil {
			slog.Debug("notification", "err", err, "out", string(out))
		}
	}()
}

func (h *macHost) readClipboard(context.Context) (string, bool) {
	var r struct {
		Text string
		OK   bool
	}
	if err := h.request("clipboard", nil, &r); err != nil {
		return "", false
	}
	return r.Text, r.OK
}

func (h *macHost) writeClipboard(text string) error {
	return h.request("setClipboard", map[string]any{"text": text}, nil)
}

// watchClipboard calls changed when the helper sees the clipboard change;
// the first call is for what's on it now.
func (h *macHost) watchClipboard(ctx context.Context, changed func()) error {
	h.mu.Lock()
	_, err := h.connect()
	h.mu.Unlock()
	if err != nil {
		return err
	}
	f := &changed
	h.watchMu.Lock()
	h.watchers[f] = struct{}{}
	h.watchMu.Unlock()
	defer func() {
		h.watchMu.Lock()
		delete(h.watchers, f)
		h.watchMu.Unlock()
	}()
	changed()
	<-ctx.Done()
	return nil
}

// inhibitSleep keeps the Mac from idle sleep until the returned func is
// called. The display may still sleep and lock; input wakes it.
func inhibitSleep(string) func() {
	cmd := exec.Command("caffeinate", "-i", "-w", fmt.Sprint(os.Getpid()))
	if err := cmd.Start(); err != nil {
		slog.Warn("cannot inhibit sleep", "err", err)
		return func() {}
	}
	go func() { _ = cmd.Wait() }()
	return func() { _ = cmd.Process.Kill() }
}
