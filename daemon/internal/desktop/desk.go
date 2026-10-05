package desktop

import (
	"context"
	"errors"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
)

// desktopHost is a desktop that sessions show and agents drive: a Hyprland
// instance on Linux (hypr.go), the interactive desktop on Windows. Its
// monitors, workspaces and windows are in Hyprland's terms; a host without
// workspaces has none.
type desktopHost interface {
	// key tells desktops apart, so a viewer only sees agents act on its own.
	key() string
	// isClaude reports whether it's Claude's desktop (claudedesk.go).
	isClaude() bool

	monitors() ([]deskMonitor, error)
	workspaces() ([]deskWorkspace, error)
	clients() ([]deskWindow, error)
	// activeWindow is the focused window's address, or "".
	activeWindow() string
	// focusAddress focuses a window by its address, showing it.
	focusAddress(address string) error
	showWorkspace(id int32) error
	// focusOutput gives a monitor keyboard focus.
	focusOutput(name string) error
	// launch starts a command line on the desktop.
	launch(command string) error
	// changes signals when the monitors, workspaces or windows may have
	// changed, until done closes. A nil channel means the host has no
	// events, and is polled instead.
	changes(done <-chan struct{}) (<-chan struct{}, error)

	// env is the environment for a worker on this desktop.
	env() []string
	// keymap is the keyboard layout its virtual keyboard should have.
	keymap() ipc.Keymap
	// notify shows a desktop notification.
	notify(summary, body string)

	// readClipboard returns the clipboard's text; false when it holds none.
	readClipboard(ctx context.Context) (string, bool)
	writeClipboard(text string) error
	// watchClipboard calls changed whenever the clipboard changes, until ctx
	// ends or watching fails. errNoClipboardWatch means it can't watch.
	watchClipboard(ctx context.Context, changed func()) error
}

// errNoClipboardWatch means the host can't watch its clipboard.
var errNoClipboardWatch = errors.New("clipboard sync unavailable")
