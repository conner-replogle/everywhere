package desktop

import (
	"log/slog"
	"slices"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/wire"
)

// watchWM keeps the viewer's workspace bar and window list current, keeps a
// captured window's geometry current (floating windows move without events,
// hence the tick), and while following, moves the capture to the monitor
// the desktop focuses.
func (s *session) watchWM() {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		events, err := s.host.changes(s.done)
		if err != nil {
			slog.Debug("desktop events", "err", err)
		} else {
			s.refreshWM()
			var debounce <-chan time.Time
		loop:
			for {
				select {
				case <-s.done:
					return
				case _, ok := <-events:
					if !ok {
						break loop
					}
					if debounce == nil {
						debounce = time.After(40 * time.Millisecond)
					}
				case <-debounce:
					debounce = nil
					s.refreshWM()
				case <-tick.C:
					s.refreshWM()
				}
			}
		}
		select {
		case <-s.done:
			return
		case <-time.After(2 * time.Second): // Hyprland restarted, or its socket hiccuped
		}
	}
}

func (s *session) refreshWM() {
	mons, err := s.host.monitors()
	if err != nil {
		return
	}
	wss, err := s.host.workspaces()
	if err != nil {
		return
	}
	active := map[string]int{}
	focused := focusedOutput(mons)
	for _, m := range mons {
		active[m.Name] = m.ActiveWorkspace.ID
	}
	var infos []wire.WorkspaceInfo
	for _, w := range wss {
		if w.ID <= 0 { // special (scratchpad) workspaces have negative ids
			continue
		}
		infos = append(infos, wire.WorkspaceInfo{
			ID: int32(w.ID), Windows: uint16(min(w.Windows, 65535)), Monitor: w.Monitor, Name: w.Name,
			Active: active[w.Monitor] == w.ID, Focused: w.Monitor == focused,
		})
	}
	slices.SortFunc(infos, func(a, b wire.WorkspaceInfo) int { return int(a.ID - b.ID) })
	msg := wire.MarshalWorkspaces(infos)
	clients, err := s.host.clients()
	if err != nil {
		return
	}
	activeWin := s.host.activeWindow()
	windows := wire.MarshalWindows(windowInfos(clients, mons, activeWin))

	s.mu.Lock()
	changed := string(msg) != string(s.wm)
	windowsChanged := string(windows) != string(s.windows)
	s.wm, s.windows, s.activeWin = msg, windows, activeWin
	dc, follow := s.control, s.follow
	current, restart := "", false
	if md := s.media; md != nil {
		current = md.output
		if md.win != nil {
			// Keep mapping the pointer right as the window moves; a window
			// that changed monitor needs a virtual pointer on the new one.
			if c := resolveWindow(clients, source{Window: md.src.Window}); c != nil {
				if mon, ok := monitorByID(mons, c.Monitor); ok {
					g := newWindowGeom(c, mon)
					restart = g.Monitor != md.win.Monitor
					md.win = g
				}
			}
		}
	}
	window := s.media != nil && s.media.win != nil
	s.mu.Unlock()
	if dc != nil {
		if changed {
			_ = dc.Send(msg)
		}
		if windowsChanged {
			_ = dc.Send(windows)
		}
	}
	if restart {
		s.mu.Lock()
		if s.media != nil && !s.closed {
			s.restartLocked(s.media.src, s.media.src)
		}
		s.mu.Unlock()
		return
	}
	if follow && !window && focused != "" && current != "" && focused != current {
		slog.Info("desktop following focus", "session", s.id, "from", current, "to", focused)
		s.switchOutput(focused)
	}
}

func (s *session) setFollow(on bool) {
	s.mu.Lock()
	s.follow = on
	s.mu.Unlock()
	if on {
		s.refreshWM()
	}
}

// showWorkspace switches to a workspace; the desktop focuses its monitor, which
// a following session then captures.
func (s *session) showWorkspace(id int32) {
	if id < 1 || id > 9999 {
		return
	}
	if err := s.host.showWorkspace(id); err != nil {
		slog.Warn("desktop workspace switch", "session", s.id, "err", err)
	}
}

// focusWindow focuses a window the viewer picked, showing its workspace; a
// following session then captures its monitor.
func (s *session) focusWindow(id string) {
	clients, err := s.host.clients()
	if err != nil {
		return
	}
	if c := resolveWindow(clients, source{Window: id}); c != nil {
		s.dispatchFocus(c.Address)
	}
}

// focusCaptured gives the captured window keyboard focus (showing its
// workspace) unless it has it, so a window stream's input only reaches it.
func (s *session) focusCaptured(win *windowGeom) {
	s.mu.Lock()
	focused := s.activeWin == win.Address
	s.mu.Unlock()
	if !focused {
		s.dispatchFocus(win.Address)
	}
}

func (s *session) dispatchFocus(address string) {
	if err := s.host.focusAddress(address); err != nil {
		slog.Warn("desktop focus window", "session", s.id, "err", err)
		return
	}
	s.mu.Lock()
	s.activeWin = address
	s.mu.Unlock()
}

// selectOutput captures a monitor the viewer picked and gives it focus, so
// keys go where the viewer is looking.
func (s *session) selectOutput(name string) {
	mons, err := s.host.monitors()
	if err != nil {
		return
	}
	if !slices.ContainsFunc(mons, func(m deskMonitor) bool { return m.Name == name && !m.Disabled }) {
		return
	}
	if err := s.host.focusOutput(name); err != nil {
		slog.Warn("desktop focus monitor", "session", s.id, "err", err)
	}
	s.switchOutput(name)
}
