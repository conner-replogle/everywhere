package desktop

import (
	"errors"
	"slices"
	"strconv"
	"strings"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/wire"
)

// errWindowGone is also the worker's error when its window closes.
var errWindowGone = errors.New("window closed")

// source is what a session captures: a whole monitor, or one window.
type source struct {
	Output string // monitor name; "" picks the focused monitor
	// Window is the window's stableId (its ext-foreign-toplevel identifier).
	Window string
	// Class and Title find the window again when its stableId is gone (a tab
	// reopened after the app restarted).
	Class, Title string
}

type hyprClient struct {
	Address   string `json:"address"`
	Mapped    bool   `json:"mapped"`
	Hidden    bool   `json:"hidden"`
	At        [2]int `json:"at"`
	Size      [2]int `json:"size"`
	Workspace struct {
		ID   int    `json:"id"`
		Name string `json:"name"`
	} `json:"workspace"`
	Monitor  int    `json:"monitor"`
	Class    string `json:"class"`
	Title    string `json:"title"`
	StableID string `json:"stableId"`
}

func (h *hyprInstance) clients() ([]hyprClient, error) {
	var cs []hyprClient
	return cs, h.requestJSON("clients", &cs)
}

// activeWindow is the focused window's address, or "".
func (h *hyprInstance) activeWindow() string {
	var w struct {
		Address string `json:"address"`
	}
	_ = h.requestJSON("activewindow", &w)
	return w.Address
}

// resolveWindow finds want's window: by stableId, else the same app and
// title, else the same app. Nil if there is none.
func resolveWindow(clients []hyprClient, want source) *hyprClient {
	live := slices.DeleteFunc(slices.Clone(clients), func(c hyprClient) bool { return !c.Mapped })
	for _, match := range []func(c hyprClient) bool{
		func(c hyprClient) bool { return want.Window != "" && c.StableID == want.Window },
		func(c hyprClient) bool { return want.Class != "" && c.Class == want.Class && c.Title == want.Title },
		func(c hyprClient) bool { return want.Class != "" && c.Class == want.Class },
	} {
		if i := slices.IndexFunc(live, match); i >= 0 {
			return &live[i]
		}
	}
	return nil
}

func monitorByID(mons []hyprMonitor, id int) (hyprMonitor, bool) {
	i := slices.IndexFunc(mons, func(m hyprMonitor) bool { return m.ID == id && !m.Disabled })
	if i < 0 {
		return hyprMonitor{}, false
	}
	return mons[i], true
}

// windowGeom places a captured window on its monitor, in layout (logical)
// coordinates, to map the viewer's pointer onto the virtual pointer, which
// spans the monitor.
type windowGeom struct {
	Address      string
	Class, Title string
	At, Size     [2]int
	MonX, MonY   int
	MonW, MonH   float64 // logical size
	Monitor      string
}

func newWindowGeom(c *hyprClient, mon hyprMonitor) *windowGeom {
	scale := mon.Scale
	if scale <= 0 {
		scale = 1
	}
	return &windowGeom{
		Address: c.Address, Class: c.Class, Title: c.Title, At: c.At, Size: c.Size,
		MonX: mon.X, MonY: mon.Y, MonW: float64(mon.Width) / scale, MonH: float64(mon.Height) / scale,
		Monitor: mon.Name,
	}
}

// toMonitor maps a point normalized across the window to one normalized across
// its monitor.
func (g *windowGeom) toMonitor(x, y uint16) (uint16, uint16) {
	lx := float64(g.At[0]-g.MonX) + float64(x)/65535*float64(g.Size[0])
	ly := float64(g.At[1]-g.MonY) + float64(y)/65535*float64(g.Size[1])
	return norm(lx, g.MonW), norm(ly, g.MonH)
}

// Linux KEY_LEFTMETA and KEY_RIGHTMETA: Super. A window stream drops it, so
// compositor shortcuts can't reach the rest of the desktop.
const keyLeftMeta, keyRightMeta = 125, 126

// windowInfos lists mapped windows for the viewer's pickers, by workspace.
func windowInfos(clients []hyprClient, mons []hyprMonitor, active string) []wire.WindowInfo {
	var out []wire.WindowInfo
	for _, c := range clients {
		if !c.Mapped || c.StableID == "" {
			continue
		}
		mon, _ := monitorByID(mons, c.Monitor)
		out = append(out, wire.WindowInfo{
			ID: c.StableID, Class: c.Class, Title: c.Title, Workspace: c.Workspace.Name, Monitor: mon.Name,
			Focused: c.Address == active,
		})
	}
	ws := func(w wire.WindowInfo) string { return w.Workspace }
	slices.SortStableFunc(out, func(a, b wire.WindowInfo) int {
		if c := compareWorkspaces(ws(a), ws(b)); c != 0 {
			return c
		}
		return strings.Compare(a.Class, b.Class)
	})
	return out
}

// compareWorkspaces orders numbered workspaces numerically, before named ones.
func compareWorkspaces(a, b string) int {
	na, errA := strconv.Atoi(a)
	nb, errB := strconv.Atoi(b)
	switch {
	case errA == nil && errB == nil:
		return na - nb
	case errA == nil:
		return -1
	case errB == nil:
		return 1
	}
	return strings.Compare(a, b)
}
