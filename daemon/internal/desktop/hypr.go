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
	"syscall"
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
// hyprland.lock with the compositor's PID and Wayland socket.
func findHyprland() (*hyprInstance, error) {
	rt := runtimeDir()
	base := filepath.Join(rt, "hypr")
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil, errNoSession
	}
	type cand struct {
		inst *hyprInstance
		mod  time.Time
	}
	var cands []cand
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
		if err != nil || syscall.Kill(pid, 0) != nil {
			continue
		}
		inst := &hyprInstance{Signature: e.Name(), Dir: dir, Runtime: rt}
		if len(lines) > 1 {
			inst.Wayland = strings.TrimSpace(lines[1])
		}
		st, err := os.Stat(filepath.Join(dir, ".socket.sock"))
		if err != nil {
			continue
		}
		cands = append(cands, cand{inst, st.ModTime()})
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

type hyprMonitor struct {
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

func (h *hyprInstance) monitors() ([]hyprMonitor, error) {
	var mons []hyprMonitor
	return mons, h.requestJSON("monitors", &mons)
}

type hyprWorkspace struct {
	ID      int    `json:"id"`
	Name    string `json:"name"`
	Monitor string `json:"monitor"`
	Windows int    `json:"windows"`
}

func (h *hyprInstance) workspaces() ([]hyprWorkspace, error) {
	var ws []hyprWorkspace
	return ws, h.requestJSON("workspaces", &ws)
}

// dispatch runs a Hyprland dispatcher. Callers build args from validated
// values only: dispatchers include exec.
func (h *hyprInstance) dispatch(args string) error {
	out, err := h.request("dispatch " + args)
	if err != nil {
		return err
	}
	if r := strings.TrimSpace(string(out)); r != "ok" {
		return fmt.Errorf("hyprland dispatch %s: %s", args, r)
	}
	return nil
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
	get := func(opt string) string {
		var v struct {
			Str string `json:"str"`
		}
		_ = h.requestJSON("getoption input:"+opt, &v)
		return v.Str
	}
	return ipc.Keymap{Rules: get("kb_rules"), Model: get("kb_model"), Layout: get("kb_layout"), Variant: get("kb_variant"), Options: get("kb_options")}
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
func focusedOutput(mons []hyprMonitor) string {
	for _, m := range mons {
		if m.Focused && !m.Disabled {
			return m.Name
		}
	}
	return ""
}

// resolveOutput picks the monitor for "" the same way capture does: eDP-1,
// else the first enabled one.
func resolveOutput(name string, mons []hyprMonitor) (hyprMonitor, bool) {
	var first *hyprMonitor
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
	return hyprMonitor{}, false
}
