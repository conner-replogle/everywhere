package desktop

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"runtime"
	"slices"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"

	"golang.org/x/sys/windows"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
	"github.com/conner-replogle/everywhere/daemon/internal/desktop/win32"
)

// On Windows the desktop is the signed-in user's interactive one, which the
// daemon runs in (it's a scheduled task in their session). There's no
// Claude's desktop, so agents use the user's. It has no workspaces, and its
// monitors are in physical pixels (scale 1).

func init() { defaultDesk = deskYours }

// windowsDesk explains the one desktop, for the tools that pick one.
const windowsDesk = "This is the user's own Windows desktop (\"yours\"; there's no separate Claude's desktop on Windows): acting moves their mouse pointer and takes their keyboard focus, and they can watch in the thread's Desktop tab."

// descriptionOverrides fits the tools' descriptions to Windows: one desktop,
// no workspaces, Windows apps and shortcuts.
var descriptionOverrides = map[string]string{
	"desktop_list":       "List the user's Windows desktop: monitors (name like DISPLAY1, size, focused) and windows (id, app, title, monitor, size), frontmost first. Windows has no workspaces. Also says what this thread's target is: the window or monitor that desktop_screenshot shows and the input tools act on.",
	"desktop_open":       "Point this thread at one window (by id from desktop_list) or one monitor (by name; neither means the focused monitor). desktop_screenshot then shows it and the input tools act on it; the user sees it in the thread's Desktop tab. A window stays the target when it moves; acting on it brings it to the front. " + windowsDesk + " Returns a screenshot.",
	"desktop_launch":     "Start an app on the user's desktop as the Run dialog would, e.g. \"notepad\", \"calc\", \"msedge https://example.com\" or a full path with arguments, and make the focused monitor this thread's target. It waits a few seconds for the app's window and returns it with a screenshot; open it with desktop_open to act on just that window. For web pages, the browser_* tools are usually better. " + windowsDesk,
	"desktop_screenshot": "Take a screenshot of this thread's target window or monitor (see desktop_open; by default the focused monitor), scaled to at most 1280px. Its pixels are the coordinates for desktop_click and the other input tools. A window is captured even when it's behind others, but not while it's minimized. Set save=true to also save a full-resolution PNG and get its path; to show the user, put ![description](path) in your reply. The image in the tool result itself is not shown to the user.",
	"desktop_focus":      "Bring a window (by id from desktop_list) to the front with keyboard focus, restoring it if it's minimized. Windows has no workspaces. It doesn't change this thread's target; use desktop_open for that.",
	"desktop_press":      "Press a key or key combination in this thread's target (a window target is focused first), like \"enter\", \"ctrl+c\", \"ctrl+shift+t\", \"alt+tab\" or \"win+d\". Names: ctrl, shift, alt, altgr, win (or super), enter, esc, tab, space, backspace, delete, insert, home, end, pageup, pagedown, up, down, left, right, f1-f24, printscreen, menu, capslock, volumeup, volumedown, mute, playpause, letters, digits and US-layout punctuation (keys are pressed by position). Windows-key combinations are Windows' own shortcuts, not the target window's; Windows doesn't let programs press ctrl+alt+delete or win+l.",
}

type windowsHost struct{}

var errNoInteractiveSession = errors.New("the daemon isn't running in a signed-in Windows session; run it with `everywhere service install`, which starts it when you sign in")

// findDesktop finds the user's desktop: the session the daemon runs in.
func findDesktop() (desktopHost, error) {
	var session uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session); err != nil || session == 0 {
		return nil, errNoInteractiveSession
	}
	return windowsHost{}, nil
}

func (windowsHost) key() string    { return "windows" }
func (windowsHost) isClaude() bool { return false }

func (windowsHost) monitors() ([]deskMonitor, error) {
	mons, err := win32.Monitors()
	if err != nil {
		return nil, err
	}
	focused := win32.MonitorOf(win32.Foreground())
	out := make([]deskMonitor, len(mons))
	for i, m := range mons {
		out[i] = deskMonitor{
			ID: i, Name: m.Name, Width: m.Rect.Width(), Height: m.Rect.Height(), X: int(m.Rect.Left), Y: int(m.Rect.Top),
			Scale: 1, Focused: m.Handle == focused,
		}
	}
	return out, nil
}

func (windowsHost) workspaces() ([]deskWorkspace, error) { return nil, nil }

func (windowsHost) clients() ([]deskWindow, error) {
	mons, err := win32.Monitors()
	if err != nil {
		return nil, err
	}
	wins, err := win32.Windows()
	if err != nil {
		return nil, err
	}
	out := make([]deskWindow, 0, len(wins))
	for _, w := range wins {
		id := win32.ID(w.HWND)
		out = append(out, deskWindow{
			Address: id, StableID: id, Mapped: true, Hidden: w.Minimized,
			At: [2]int{int(w.Rect.Left), int(w.Rect.Top)}, Size: [2]int{w.Rect.Width(), w.Rect.Height()},
			Monitor: slices.IndexFunc(mons, func(m win32.Monitor) bool { return m.Handle == w.Monitor }),
			Class:   w.App, Title: w.Title, Pid: int(w.Pid),
		})
	}
	return out, nil
}

func (windowsHost) activeWindow() string {
	if h := win32.Foreground(); h != 0 {
		return win32.ID(h)
	}
	return ""
}

func (windowsHost) focusAddress(address string) error {
	h, err := win32.ParseID(address)
	if err != nil {
		return err
	}
	return win32.Focus(h)
}

func (windowsHost) showWorkspace(int32) error {
	return errors.New("Windows has no workspaces")
}

// focusOutput does nothing: Windows gives windows focus, not monitors.
func (windowsHost) focusOutput(string) error { return nil }

// launch runs command as the Run dialog would, through cmd's start: an app
// name (notepad, msedge), a path, or a URL, with arguments.
func (windowsHost) launch(command string) error {
	cmd := exec.Command("cmd.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine:       `cmd.exe /d /s /c "start "" ` + command + `"`,
		CreationFlags: windows.CREATE_NO_WINDOW,
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("starting %q: %w %s", command, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// changes: windows come and go without events here; the session polls.
func (windowsHost) changes(<-chan struct{}) (<-chan struct{}, error) { return nil, nil }

func (windowsHost) env() []string      { return os.Environ() }
func (windowsHost) keymap() ipc.Keymap { return ipc.Keymap{} }

// notify shows a toast, through PowerShell's app identity (the daemon has none).
func (windowsHost) notify(summary, body string) {
	esc := func(s string) string {
		return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "'", "''").Replace(s)
	}
	script := `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>` + esc(summary) + `</text><text>` + esc(body) + `</text></binding></visual></toast>')
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))`
	u := utf16.Encode([]rune(script))
	b := make([]byte, 2*len(u))
	for i, c := range u {
		b[2*i], b[2*i+1] = byte(c), byte(c>>8)
	}
	go func() {
		cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", base64.StdEncoding.EncodeToString(b))
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
		if out, err := cmd.CombinedOutput(); err != nil {
			slog.Debug("toast", "err", err, "out", string(out))
		}
	}()
}

func (windowsHost) readClipboard(context.Context) (string, bool) { return win32.ReadClipboard() }

func (windowsHost) writeClipboard(text string) error { return win32.WriteClipboard(text) }

// watchClipboard polls the clipboard's sequence number; the first call is
// for what's on it now.
func (windowsHost) watchClipboard(ctx context.Context, changed func()) error {
	seq := win32.ClipboardSequence()
	changed()
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-tick.C:
			if s := win32.ClipboardSequence(); s != seq {
				seq = s
				changed()
			}
		}
	}
}

// inhibitSleep keeps Windows from sleeping until the returned func is
// called. The request belongs to a thread, so one is kept for it.
func inhibitSleep(string) func() {
	const esContinuous, esSystemRequired = 0x80000000, 0x00000001
	proc := windows.NewLazySystemDLL("kernel32.dll").NewProc("SetThreadExecutionState")
	release := make(chan struct{})
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		proc.Call(esContinuous | esSystemRequired)
		<-release
		proc.Call(esContinuous)
	}()
	return func() { close(release) }
}
