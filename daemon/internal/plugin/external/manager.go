package external

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"slices"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/dashboard"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// Load makes plugins of those installed under root that are enabled on the
// device, and a Manager for them. Installed plugins whose manifests are bad
// are reported by the manager.
func Load(root string, enabled func(id string) bool, setEnabled func(id string, on bool) error) (*Manager, []plugin.Plugin) {
	installed, bad := Installed(root)
	m := &Manager{
		root: root, installed: installed, bad: bad, enabled: enabled, setEnabled: setEnabled, running: map[string]*Plugin{},
		failed: map[string]failure{}, poke: make(chan struct{}, 1), stop: make(chan struct{}),
	}
	var out []plugin.Plugin
	ids := make([]string, 0, len(installed))
	for id := range installed {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if !enabled(id) {
			continue
		}
		p := New(filepath.Join(root, id), installed[id])
		m.running[id] = p
		out = append(out, p)
	}
	for id, err := range bad {
		slog.Warn("plugin not loaded", "plugin", id, "err", err)
	}
	return m, out
}

// Manager is the "plugins" plugin: it lists the installed plugins, builds
// their web parts, turns them off, and keeps what runs in step with what's
// installed and enabled, so `everywhere plugin` needs no restart.
type Manager struct {
	root       string
	enabled    func(string) bool
	setEnabled func(string, bool) error
	builds     *dashboard.Builder
	h          plugin.Host
	reg        atomic.Pointer[plugin.Registry]
	poke       chan struct{}
	stop       chan struct{}

	mu        sync.Mutex
	installed map[string]Manifest
	bad       map[string]error
	running   map[string]*Plugin
	// failed holds why enabled plugins didn't start, until what they were
	// tried with (their files, the plugins they require) changes.
	failed map[string]failure
}

type failure struct {
	err error
	key string
}

// Attach gives the manager the registry to start and stop plugins in;
// until then it only reports.
func (m *Manager) Attach(r *plugin.Registry) {
	m.reg.Store(r)
	m.Reconcile()
}

// Reconcile asks for what runs to be brought in step with what's installed
// and enabled, soon.
func (m *Manager) Reconcile() {
	select {
	case m.poke <- struct{}{}:
	default:
	}
}

func (m *Manager) Manifest() plugin.Manifest {
	return plugin.Manifest{ID: "plugins", Title: "Plugins", API: plugin.API, Builtin: true}
}

// InstalledPlugin is one installed plugin, as plugins.installed reports it.
type InstalledPlugin struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Version     string   `json:"version,omitempty"`
	Description string   `json:"description,omitempty"`
	Permissions []string `json:"permissions,omitempty"`
	Enabled     bool     `json:"enabled"`
	Running     bool     `json:"running"`
	Error       string   `json:"error,omitempty"`
}

func (m *Manager) Start(h plugin.Host) error {
	m.h = h
	m.builds = dashboard.NewBuilder()
	go m.watch()
	h.HandleRPC("plugins.installed", plugin.Params(func(plugin.RPCContext, struct{}) (any, error) {
		m.mu.Lock()
		defer m.mu.Unlock()
		out := []InstalledPlugin{}
		for id, man := range m.installed {
			p := m.running[id]
			ip := InstalledPlugin{
				ID: id, Title: man.Title, Version: man.Version, Description: man.Description, Permissions: man.Permissions,
				Enabled: m.enabled(id), Running: p != nil && p.Running(),
			}
			if f, ok := m.failed[id]; ok {
				ip.Error = f.err.Error()
			}
			out = append(out, ip)
		}
		for id, err := range m.bad {
			out = append(out, InstalledPlugin{ID: id, Title: id, Error: err.Error()})
		}
		sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
		return out, nil
	}))
	// A plugin's web part, built here like a dashboard; viewers ask with the
	// version they have, so an unchanged one isn't sent again.
	h.HandleRPC("plugins.web", plugin.Params(func(_ plugin.RPCContext, r struct {
		ID      string `json:"id"`
		Version string `json:"version"`
	}) (any, error) {
		m.mu.Lock()
		p := m.running[r.ID]
		m.mu.Unlock()
		if p == nil || p.Spec().Web == "" {
			return nil, errors.New("no such plugin with a web part")
		}
		res := m.builds.BuildWithTypes(filepath.Join(p.Dir(), p.Spec().Web), p.Dir())
		if r.Version == res.Version {
			return protocol.DashboardBuild{Version: res.Version, Unchanged: true}, nil
		}
		return protocol.DashboardBuild{Version: res.Version, JS: res.JS, CSS: res.CSS, Errors: res.Errors}, nil
	}))
	// Settings: the form's data, and saving the device's values.
	type settingsParams struct {
		ID     string                     `json:"id"`
		Values map[string]json.RawMessage `json:"values"`
	}
	h.HandleRPC("plugins.settings", plugin.Params(func(_ plugin.RPCContext, r settingsParams) (any, error) {
		m.mu.Lock()
		man, ok := m.installed[r.ID]
		m.mu.Unlock()
		if !ok {
			return nil, errors.New("no such plugin")
		}
		return struct {
			Settings []protocol.PluginSetting `json:"settings"`
			Values   map[string]SettingView   `json:"values"`
		}{man.Settings, View(h.Store(), man)}, nil
	}))
	h.HandleRPC("plugins.setSettings", plugin.Params(func(_ plugin.RPCContext, r settingsParams) (any, error) {
		m.mu.Lock()
		man, ok := m.installed[r.ID]
		p := m.running[r.ID]
		m.mu.Unlock()
		if !ok {
			return nil, errors.New("no such plugin")
		}
		if err := SetDevice(h.Store(), man, r.Values); err != nil {
			return nil, err
		}
		if p != nil {
			p.Reconfigure()
		}
		m.uiChanged(r.ID)
		return View(h.Store(), man), nil
	}))
	// The account's values, from the hub: on connecting, and when they change.
	h.HandleRPC("plugins.setAccountSettings", plugin.Params(func(_ plugin.RPCContext, r settingsParams) (any, error) {
		if err := SetAccount(h.Store(), r.ID, r.Values); err != nil {
			return nil, err
		}
		m.mu.Lock()
		p := m.running[r.ID]
		m.mu.Unlock()
		if p != nil {
			p.Reconfigure()
		}
		m.uiChanged(r.ID)
		return plugin.Empty{}, nil
	}), plugin.RemoteOnly())
	// A plugin's web part's state, which its frame reads and writes through
	// the app (only its own: the app fixes the plugin).
	for _, method := range []string{"get", "set", "delete", "list", "scopes"} {
		h.HandleRPC("plugins.kv."+method, plugin.Params(func(_ plugin.RPCContext, r struct {
			Plugin string `json:"plugin"`
			plugin.KVParams
		}) (any, error) {
			m.mu.Lock()
			_, ok := m.installed[r.Plugin]
			m.mu.Unlock()
			if !ok {
				return nil, errors.New("no such plugin")
			}
			return plugin.CallKV(plugin.NewKV(h.Store(), r.Plugin, h.Emit), method, r.KVParams)
		}))
	}
	// Turning a plugin off is safe from anywhere; turning one on takes the
	// device itself (everywhere plugin enable).
	h.HandleRPC("plugins.disable", plugin.Params(func(_ plugin.RPCContext, r struct {
		ID string `json:"id"`
	}) (any, error) {
		m.mu.Lock()
		_, ok := m.installed[r.ID]
		m.mu.Unlock()
		if !ok {
			return nil, errors.New("no such plugin")
		}
		if err := m.setEnabled(r.ID, false); err != nil {
			return nil, err
		}
		m.Reconcile()
		return plugin.Empty{}, nil
	}))
	return nil
}

func (m *Manager) Stop() { close(m.stop) }

// uiChanged tells browsers to ask a plugin for its UI data again: what it
// shows usually depends on its settings. A moment later, so the plugin has
// its new settings first.
func (m *Manager) uiChanged(id string) {
	time.AfterFunc(200*time.Millisecond, func() {
		m.h.Emit(protocol.RPCEvent{Event: id + ".ui.changed"})
	})
}

// How often the plugins directory and config are looked at.
const watchEvery = 3 * time.Second

func (m *Manager) watch() {
	t := time.NewTicker(watchEvery)
	defer t.Stop()
	for {
		select {
		case <-m.stop:
			return
		case <-t.C:
		case <-m.poke:
		}
		if r := m.reg.Load(); r != nil && m.reconcile(r) {
			m.h.Emit(protocol.RPCEvent{Event: protocol.EventPluginsChanged})
		}
	}
}

// reconcile starts enabled plugins that aren't running, and stops running
// ones that were disabled, removed or replaced (a replaced one starts
// again next time, from its new files). One that fails to start isn't
// tried again until its files or the plugins it requires change. It
// reports whether anything changed.
func (m *Manager) reconcile(r *plugin.Registry) bool {
	installed, bad := Installed(m.root)
	m.mu.Lock()
	changed := !sameKeys(bad, m.bad) || len(installed) != len(m.installed)
	m.installed, m.bad = installed, bad
	// Loaded at startup but not started by the registry (it failed, or
	// needed a plugin that wasn't running): tried again below.
	for id, p := range m.running {
		if !r.Started(id) {
			p.Stop()
			delete(m.running, id)
		}
	}
	for id := range m.failed {
		if _, ok := installed[id]; !ok || !m.enabled(id) {
			delete(m.failed, id)
			changed = true
		}
	}
	var stop []string
	for id, p := range m.running {
		man, ok := installed[id]
		if !ok || !m.enabled(id) || !sameManifest(man, p.Spec()) || Stamp(p.Dir(), man) != p.stamp {
			stop = append(stop, id)
		}
	}
	var start []string
	for id := range installed {
		if _, ok := m.running[id]; !ok && m.enabled(id) && !slices.Contains(stop, id) {
			if f, ok := m.failed[id]; ok && f.key == startKey(r, filepath.Join(m.root, id), installed[id]) {
				continue
			}
			start = append(start, id)
		}
	}
	m.mu.Unlock()
	sort.Strings(start)

	for _, id := range stop {
		slog.Info("stopping plugin", "plugin", id)
		r.StopPlugin(id)
		m.mu.Lock()
		delete(m.running, id)
		m.mu.Unlock()
		changed = true
	}
	for _, id := range start {
		dir := filepath.Join(m.root, id)
		key := startKey(r, dir, installed[id])
		p := New(dir, installed[id])
		if err := r.StartPlugin(p); err != nil {
			p.Stop()
			slog.Warn("plugin not started", "plugin", id, "err", err)
			m.mu.Lock()
			m.failed[id] = failure{err: err, key: key}
			m.mu.Unlock()
			changed = true
			continue
		}
		slog.Info("plugin loaded", "plugin", id)
		m.mu.Lock()
		m.running[id] = p
		delete(m.failed, id)
		m.mu.Unlock()
		changed = true
	}
	return changed
}

// startKey is what starting a plugin depends on: its manifest, its
// program, and which plugins it requires are running.
func startKey(r *plugin.Registry, dir string, man Manifest) string {
	b, _ := json.Marshal(man)
	key := string(b) + "\x00" + Stamp(dir, man)
	for _, dep := range man.Requires {
		key += fmt.Sprintf("\x00%s=%t", dep, r.Started(dep))
	}
	return key
}

func sameManifest(a, b Manifest) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

func sameKeys[V any](a, b map[string]V) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if _, ok := b[k]; !ok {
			return false
		}
	}
	return true
}
