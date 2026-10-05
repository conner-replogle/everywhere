package desktop

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
)

// errNoSession means no Hyprland is running for this user (not logged in to the
// desktop, or a different compositor).
var errNoSession = errors.New("no Hyprland session is running for this user")

// hyprInstance is a running Hyprland: its IPC directory and Wayland socket.
type hyprInstance struct {
	Signature string
	Dir       string // $XDG_RUNTIME_DIR/hypr/<signature>
	Wayland   string // wayland socket name, e.g. wayland-1
	Runtime   string // $XDG_RUNTIME_DIR
	Claude    bool   // it's Claude's desktop (claudedesk.go)

	lua atomic.Bool // dispatches take Lua (the config is Lua, as Omarchy's is)
}

func runtimeDir() string {
	if d := os.Getenv("XDG_RUNTIME_DIR"); d != "" {
		return d
	}
	return fmt.Sprintf("/run/user/%d", os.Getuid())
}

// findHyprland locates the live Hyprland instance. The daemon is a lingering
// user service that may have started before (or outlived) the desktop session,
// so its own environment can't be trusted: each instance directory holds a
// hyprland.lock with the compositor's PID and Wayland socket. Claude's desktop
// (see claudedesk.go) is another instance, never this one.
func findHyprland() (*hyprInstance, error) {
	var cands []hyprCandidate
	for _, c := range hyprInstances() {
		if !c.inst.Claude {
			cands = append(cands, c)
		}
	}
	if len(cands) == 0 {
		return nil, errNoSession
	}
	// Prefer the instance our environment names, then the newest.
	sig := os.Getenv("HYPRLAND_INSTANCE_SIGNATURE")
	sort.Slice(cands, func(i, j int) bool {
		if (cands[i].inst.Signature == sig) != (cands[j].inst.Signature == sig) {
			return cands[i].inst.Signature == sig
		}
		return cands[i].mod.After(cands[j].mod)
	})
	return cands[0].inst, nil
}

type hyprCandidate struct {
	inst *hyprInstance
	pid  int
	mod  time.Time
}

// hyprInstances lists this user's live Hyprland instances.
func hyprInstances() []hyprCandidate {
	rt := runtimeDir()
	base := filepath.Join(rt, "hypr")
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil
	}
	var cands []hyprCandidate
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(base, e.Name())
		lock, err := os.ReadFile(filepath.Join(dir, "hyprland.lock"))
		if err != nil {
			continue
		}
		lines := strings.Split(strings.TrimSpace(string(lock)), "\n")
		pid, err := strconv.Atoi(strings.TrimSpace(lines[0]))
		if err != nil || !alive(pid) {
			continue
		}
		inst := &hyprInstance{Signature: e.Name(), Dir: dir, Runtime: rt, Claude: isClaudeDesktop(pid)}
		if len(lines) > 1 {
			inst.Wayland = strings.TrimSpace(lines[1])
		}
		st, err := os.Stat(filepath.Join(dir, ".socket.sock"))
		if err != nil {
			continue
		}
		cands = append(cands, hyprCandidate{inst, pid, st.ModTime()})
	}
	return cands
}

// request sends one command over Hyprland's IPC socket and returns the reply.
func (h *hyprInstance) request(cmd string) ([]byte, error) {
	conn, err := net.DialTimeout("unix", filepath.Join(h.Dir, ".socket.sock"), 2*time.Second)
	if err != nil {
		return nil, fmt.Errorf("hyprland ipc: %w", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write([]byte(cmd)); err != nil {
		return nil, fmt.Errorf("hyprland ipc: %w", err)
	}
	out, err := io.ReadAll(conn)
	if err != nil {
		return nil, fmt.Errorf("hyprland ipc: %w", err)
	}
	return out, nil
}

func (h *hyprInstance) requestJSON(cmd string, v any) error {
	out, err := h.request("j/" + cmd)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(out, v); err != nil {
		return fmt.Errorf("hyprland %s: %w", cmd, err)
	}
	return nil
}

type deskMonitor struct {
	ID              int     `json:"id"`
	Name            string  `json:"name"`
	Width           int     `json:"width"`
	Height          int     `json:"height"`
	X               int     `json:"x"`
	Y               int     `json:"y"`
	Scale           float64 `json:"scale"`
	Disabled        bool    `json:"disabled"`
	Focused         bool    `json:"focused"`
	ActiveWorkspace struct {
		ID int `json:"id"`
	} `json:"activeWorkspace"`
}

func (h *hyprInstance) monitors() ([]deskMonitor, error) {
	var mons []deskMonitor
	return mons, h.requestJSON("monitors", &mons)
}

type deskWorkspace struct {
	ID      int    `json:"id"`
	Name    string `json:"name"`
	Monitor string `json:"monitor"`
	Windows int    `json:"windows"`
}

func (h *hyprInstance) workspaces() ([]deskWorkspace, error) {
	var ws []deskWorkspace
	return ws, h.requestJSON("workspaces", &ws)
}

// dispatcher is one dispatch in both of Hyprland's config languages: with a
// Lua config, IPC dispatches are Lua (`hl.dsp.focus({ workspace = "3" })`);
// with hyprlang, the classic form (`workspace 3`). Callers build both from
// validated values only: dispatchers include exec.
type dispatcher struct {
	classic, lua string
}

func focusWorkspace(id int32) dispatcher {
	return dispatcher{fmt.Sprintf("workspace %d", id), fmt.Sprintf(`hl.dsp.focus({ workspace = "%d" })`, id)}
}

func focusMonitor(name string) dispatcher {
	return dispatcher{"focusmonitor " + name, "hl.dsp.focus({ monitor = " + strconv.Quote(name) + " })"}
}

func focusWindowAddress(address string) dispatcher {
	return dispatcher{"focuswindow address:" + address, `hl.dsp.focus({ window = "address:` + address + `" })`}
}

// focusAddress focuses a window by its address, showing its workspace.
func (h *hyprInstance) focusAddress(address string) error {
	if !strings.HasPrefix(address, "0x") || strings.ContainsAny(address, " ,;\"") {
		return fmt.Errorf("bad window address %q", address)
	}
	return h.dispatch(focusWindowAddress(address))
}

// dispatch runs d in the syntax that last worked, falling back to the other.
func (h *hyprInstance) dispatch(d dispatcher) error {
	forms := []string{d.classic, d.lua}
	if h.lua.Load() {
		forms = []string{d.lua, d.classic}
	}
	var firstErr error
	for _, f := range forms {
		out, err := h.request("dispatch " + f)
		if err == nil && strings.TrimSpace(string(out)) == "ok" {
			h.lua.Store(f == d.lua)
			return nil
		}
		if err == nil {
			err = fmt.Errorf("hyprland dispatch %s: %s", f, strings.TrimSpace(string(out)))
		}
		if firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (h *hyprInstance) key() string    { return h.Signature }
func (h *hyprInstance) isClaude() bool { return h.Claude }

func (h *hyprInstance) showWorkspace(id int32) error  { return h.dispatch(focusWorkspace(id)) }
func (h *hyprInstance) focusOutput(name string) error { return h.dispatch(focusMonitor(name)) }
func (h *hyprInstance) launch(command string) error   { return h.dispatch(execCmd(command)) }

// Hyprland events that change the workspaces, the windows, or which monitor
// has focus.
var wmEvents = map[string]bool{
	"workspace": true, "workspacev2": true, "focusedmon": true, "focusedmonv2": true,
	"createworkspace": true, "createworkspacev2": true, "destroyworkspace": true, "destroyworkspacev2": true,
	"moveworkspace": true, "moveworkspacev2": true, "renameworkspace": true, "activespecial": true, "activespecialv2": true,
	"openwindow": true, "closewindow": true, "movewindow": true, "movewindowv2": true,
	"monitoradded": true, "monitoraddedv2": true, "monitorremoved": true, "monitorremovedv2": true,
	"activewindowv2": true, "windowtitlev2": true, "changefloatingmode": true, "fullscreen": true,
}

func (h *hyprInstance) changes(done <-chan struct{}) (<-chan struct{}, error) {
	events, err := h.events(done)
	if err != nil {
		return nil, err
	}
	out := make(chan struct{}, 1)
	go func() {
		defer close(out)
		for name := range events {
			if !wmEvents[name] {
				continue
			}
			select {
			case out <- struct{}{}:
			default: // one is pending already
			}
		}
	}()
	return out, nil
}

// events streams Hyprland's event names (the part before ">>") until done
// closes. The channel closes when the connection ends.
func (h *hyprInstance) events(done <-chan struct{}) (<-chan string, error) {
	conn, err := net.DialTimeout("unix", filepath.Join(h.Dir, ".socket2.sock"), 2*time.Second)
	if err != nil {
		return nil, fmt.Errorf("hyprland events: %w", err)
	}
	out := make(chan string, 64)
	go func() {
		<-done
		conn.Close()
	}()
	go func() {
		defer close(out)
		sc := bufio.NewScanner(conn)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			name, _, _ := strings.Cut(sc.Text(), ">>")
			select {
			case out <- name:
			case <-done:
				return
			default: // the reader is behind; it refreshes everything anyway
			}
		}
	}()
	return out, nil
}

// keymap reads the host's XKB settings so the virtual keyboard types exactly
// like the physical one.
func (h *hyprInstance) keymap() ipc.Keymap {
	kb := h.keymapValues()
	return ipc.Keymap{Rules: kb["kb_rules"], Model: kb["kb_model"], Layout: kb["kb_layout"], Variant: kb["kb_variant"], Options: kb["kb_options"]}
}

// keymapValues are the input:kb_* options, by name.
func (h *hyprInstance) keymapValues() map[string]string {
	kb := map[string]string{}
	for _, k := range []string{"kb_rules", "kb_model", "kb_layout", "kb_variant", "kb_options"} {
		var v struct {
			Str string `json:"str"`
		}
		_ = h.requestJSON("getoption input:"+k, &v)
		if v.Str != "[[EMPTY]]" { // how Hyprland shows an unset string
			kb[k] = v.Str
		}
	}
	return kb
}

// env is the environment for a worker in this session: Wayland needs
// XDG_RUNTIME_DIR and WAYLAND_DISPLAY.
func (h *hyprInstance) env() []string {
	var env []string
	for _, kv := range os.Environ() {
		switch k, _, _ := strings.Cut(kv, "="); k {
		case "WAYLAND_DISPLAY", "HYPRLAND_INSTANCE_SIGNATURE", "XDG_RUNTIME_DIR", "DISPLAY":
		default:
			env = append(env, kv)
		}
	}
	wl := h.Wayland
	if wl == "" {
		wl = "wayland-1"
	}
	return append(env, "XDG_RUNTIME_DIR="+h.Runtime, "WAYLAND_DISPLAY="+wl, "HYPRLAND_INSTANCE_SIGNATURE="+h.Signature)
}

// focusedOutput is the monitor Hyprland has focused, or "".
func focusedOutput(mons []deskMonitor) string {
	for _, m := range mons {
		if m.Focused && !m.Disabled {
			return m.Name
		}
	}
	return ""
}

// resolveOutput picks the monitor for "" the same way capture does: eDP-1,
// else the first enabled one.
func resolveOutput(name string, mons []deskMonitor) (deskMonitor, bool) {
	var first *deskMonitor
	for i, m := range mons {
		if m.Disabled {
			continue
		}
		if first == nil {
			first = &mons[i]
		}
		if m.Name == name || (name == "" && m.Name == "eDP-1") {
			return m, true
		}
	}
	if name == "" && first != nil {
		return *first, true
	}
	return deskMonitor{}, false
}
