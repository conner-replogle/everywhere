package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sort"
	"strings"
	"sync"

	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

// Core is what the daemon's core gives the registry to host plugins with.
type Core interface {
	Store() *store.Store
	Info() protocol.DeviceInfo
	DataDir() string
	Threads() Threads
	// Broadcast sends an event to every connected browser.
	Broadcast(event any)
	// Notify sends a notification through the hub.
	Notify(n protocol.HubNotify)
	WebRTC() WebRTC
	Config() Config
}

// CoreID is the core's own id in the registry: its methods are registered
// like a plugin's.
const CoreID = "core"

// Registry hosts plugins: it starts them, holds what they register and
// dispatches to it.
type Registry struct {
	core  Core
	bus   *Bus
	tools *mcp.Server

	mu       sync.RWMutex
	plugins  []Plugin
	started  []*entry
	rpc      map[string]*RPCSpec
	channels []channelReg
	sessKind map[string]sessionReg
	kinds    map[string]kindReg
	tooldefs []toolReg
	agent    []contribReg
	decor    []decorReg
	services map[string]serviceReg

	sessMu   sync.Mutex
	sessions map[string]*session
}

type entry struct {
	p    Plugin
	m    Manifest
	host *host
}

type channelReg struct {
	plugin, prefix string
	fn             ChannelFunc
}

type sessionReg struct {
	plugin string
	h      SessionHandler
}

type kindReg struct {
	plugin string
	h      KindHandler
}

type toolReg struct {
	plugin string
	t      Tool
}

type contribReg struct {
	plugin string
	fn     func(AgentLaunch) AgentContribution
}

type decorReg struct {
	plugin string
	fn     func(*protocol.Thread)
}

type serviceReg struct {
	plugin string
	svc    any
}

// NewRegistry makes a registry for plugins; Start starts them.
func NewRegistry(name, version string, plugins ...Plugin) *Registry {
	r := &Registry{
		bus:      NewBus(),
		tools:    mcp.NewServer(name, version, nil),
		plugins:  plugins,
		rpc:      map[string]*RPCSpec{},
		sessKind: map[string]sessionReg{},
		kinds:    map[string]kindReg{},
		services: map[string]serviceReg{},
		sessions: map[string]*session{},
	}
	return r
}

// Add registers more plugins before Start.
func (r *Registry) Add(plugins ...Plugin) { r.plugins = append(r.plugins, plugins...) }

// Bus is the registry's event bus.
func (r *Registry) Bus() *Bus { return r.bus }

// MCP is the daemon's MCP server for claude processes.
func (r *Registry) MCP() *mcp.Server { return r.tools }

// Core returns the core's own host, for registering its methods.
func (r *Registry) Core(core Core) Host {
	r.core = core
	h := &host{r: r, id: CoreID}
	r.registerSessionMethods(h)
	return h
}

// Start starts the plugins in dependency order. A plugin whose required
// plugins are missing or failed isn't started.
func (r *Registry) Start(core Core) {
	r.core = core
	byID := map[string]Plugin{}
	for _, p := range r.plugins {
		m := p.Manifest()
		if _, dup := byID[m.ID]; dup || m.ID == "" || m.ID == CoreID {
			slog.Error("plugin skipped: bad or duplicate id", "plugin", m.ID)
			continue
		}
		byID[m.ID] = p
	}
	order, err := startOrder(byID)
	if err != nil {
		slog.Error("plugins", "err", err)
	}
	ok := map[string]bool{}
	for _, id := range order {
		p := byID[id]
		m := p.Manifest()
		if m.API != API {
			slog.Error("plugin skipped: built for another API", "plugin", id, "api", m.API, "want", API)
			continue
		}
		missing := ""
		for _, dep := range m.Requires {
			if !ok[dep] {
				missing = dep
				break
			}
		}
		if missing != "" {
			slog.Error("plugin skipped: a plugin it requires isn't running", "plugin", id, "requires", missing)
			continue
		}
		h := &host{r: r, id: id}
		if err := safeStart(p, h); err != nil {
			slog.Error("plugin failed to start", "plugin", id, "err", err)
			r.remove(id)
			continue
		}
		ok[id] = true
		r.mu.Lock()
		r.started = append(r.started, &entry{p: p, m: m, host: h})
		r.mu.Unlock()
		slog.Debug("plugin started", "plugin", id)
	}
}

func safeStart(p Plugin, h *host) (err error) {
	defer func() {
		if v := recover(); v != nil {
			err = fmt.Errorf("panic: %v", v)
		}
	}()
	return p.Start(h)
}

// startOrder sorts plugins so each comes after what it requires or
// optionally uses (if present). Ties keep registration order.
func startOrder(byID map[string]Plugin) ([]string, error) {
	ids := make([]string, 0, len(byID))
	for id := range byID {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var order []string
	state := map[string]int{} // 1 visiting, 2 done
	var errs []error
	var visit func(id string, path []string)
	visit = func(id string, path []string) {
		switch state[id] {
		case 1:
			errs = append(errs, fmt.Errorf("dependency cycle: %s", strings.Join(append(path, id), " → ")))
			return
		case 2:
			return
		}
		state[id] = 1
		m := byID[id].Manifest()
		for _, dep := range append(append([]string{}, m.Requires...), m.Optional...) {
			if _, ok := byID[dep]; ok {
				visit(dep, append(path, id))
			}
		}
		state[id] = 2
		order = append(order, id)
	}
	for _, id := range ids {
		visit(id, nil)
	}
	return order, errors.Join(errs...)
}

// Stop stops the plugins in reverse start order, then closes any sessions
// they left open: plugins first, so they can tell their own viewers why.
func (r *Registry) Stop() {
	Publish(r.bus, DaemonStopping, struct{}{})
	r.mu.RLock()
	started := slices.Clone(r.started)
	r.mu.RUnlock()
	for i := len(started) - 1; i >= 0; i-- {
		func() {
			defer func() {
				if v := recover(); v != nil {
					slog.Error("plugin panicked stopping", "plugin", started[i].m.ID, "panic", v)
				}
			}()
			started[i].p.Stop()
		}()
	}
	r.sessMu.Lock()
	sessions := make([]*session, 0, len(r.sessions))
	for _, s := range r.sessions {
		sessions = append(sessions, s)
	}
	r.sessMu.Unlock()
	for _, s := range sessions {
		s.Close("The device is shutting down")
	}
	r.tools.Close()
}

// StopPlugin stops one plugin and drops what it registered (external
// plugins being disabled or crashing).
func (r *Registry) StopPlugin(id string) {
	r.mu.Lock()
	var e *entry
	for i, s := range r.started {
		if s.m.ID == id {
			e = s
			r.started = slices.Delete(r.started, i, i+1)
			break
		}
	}
	r.mu.Unlock()
	if e != nil {
		e.p.Stop()
	}
	r.remove(id)
}

// StartPlugin starts one more plugin after Start (an external plugin
// being enabled).
func (r *Registry) StartPlugin(p Plugin) error {
	m := p.Manifest()
	if m.API != API {
		return fmt.Errorf("plugin %s is built for plugin API %d; this daemon has %d", m.ID, m.API, API)
	}
	r.mu.RLock()
	running := map[string]bool{}
	for _, e := range r.started {
		running[e.m.ID] = true
	}
	r.mu.RUnlock()
	if running[m.ID] || m.ID == CoreID {
		return fmt.Errorf("plugin %s is already running", m.ID)
	}
	for _, dep := range m.Requires {
		if !running[dep] {
			return fmt.Errorf("plugin %s requires %s, which isn't running", m.ID, dep)
		}
	}
	h := &host{r: r, id: m.ID}
	if err := safeStart(p, h); err != nil {
		r.remove(m.ID)
		return err
	}
	r.mu.Lock()
	r.started = append(r.started, &entry{p: p, m: m, host: h})
	r.mu.Unlock()
	return nil
}

// remove drops everything a plugin registered.
func (r *Registry) remove(id string) {
	r.mu.Lock()
	for k, s := range r.rpc {
		if s.Plugin == id {
			delete(r.rpc, k)
		}
	}
	r.channels = slices.DeleteFunc(r.channels, func(c channelReg) bool { return c.plugin == id })
	for k, s := range r.sessKind {
		if s.plugin == id {
			delete(r.sessKind, k)
		}
	}
	for k, s := range r.kinds {
		if s.plugin == id {
			delete(r.kinds, k)
		}
	}
	r.tooldefs = slices.DeleteFunc(r.tooldefs, func(t toolReg) bool { return t.plugin == id })
	r.agent = slices.DeleteFunc(r.agent, func(c contribReg) bool { return c.plugin == id })
	r.decor = slices.DeleteFunc(r.decor, func(d decorReg) bool { return d.plugin == id })
	for k, s := range r.services {
		if s.plugin == id {
			delete(r.services, k)
		}
	}
	r.mu.Unlock()
	r.syncTools()
	r.sessMu.Lock()
	var closing []*session
	for _, s := range r.sessions {
		if s.plugin == id {
			closing = append(closing, s)
		}
	}
	r.sessMu.Unlock()
	for _, s := range closing {
		s.Close("The plugin stopped")
	}
}

func (r *Registry) syncTools() {
	r.mu.RLock()
	tools := make([]mcp.Tool, 0, len(r.tooldefs))
	for _, t := range r.tooldefs {
		tools = append(tools, t.t.Tool)
	}
	r.mu.RUnlock()
	r.tools.SetTools(tools)
}

// Call runs a control method.
func (r *Registry) Call(ctx context.Context, method string, c RPCContext, params json.RawMessage) (res any, err error) {
	r.mu.RLock()
	spec := r.rpc[method]
	r.mu.RUnlock()
	if spec == nil || (spec.RemoteOnly && !c.Remote) {
		return nil, fmt.Errorf("unknown method %q", method)
	}
	if c.Remote && !spec.Remote {
		return nil, fmt.Errorf("%s isn't available remotely", method)
	}
	defer func() {
		if v := recover(); v != nil {
			slog.Error("rpc handler panicked", "method", method, "plugin", spec.Plugin, "panic", v)
			res, err = nil, fmt.Errorf("internal error in %s", method)
		}
	}()
	return spec.Fn(ctx, c, params)
}

// Slow reports whether a method is answered concurrently.
func (r *Registry) Slow(method string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s := r.rpc[method]
	return s != nil && s.Slow
}

// Channel finds the handler of a data channel label: the longest
// registered prefix it starts with.
func (r *Registry) Channel(label string) (ChannelFunc, string, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	best := -1
	for i, c := range r.channels {
		if strings.HasPrefix(label, c.prefix) && (best < 0 || len(c.prefix) > len(r.channels[best].prefix)) {
			best = i
		}
	}
	if best < 0 {
		return nil, "", false
	}
	c := r.channels[best]
	return c.fn, strings.TrimPrefix(label, c.prefix), true
}

// Kind finds a thread or tab kind.
func (r *Registry) Kind(kind string) (KindHandler, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	k, ok := r.kinds[kind]
	return k.h, ok
}

// Decorate fills a thread's live fields.
func (r *Registry) Decorate(t *protocol.Thread) {
	if k, ok := r.Kind(t.Kind); ok && k.Status != nil {
		t.Running, t.AgentStatus = k.Status(*t)
	}
	r.mu.RLock()
	decor := slices.Clone(r.decor)
	r.mu.RUnlock()
	for _, d := range decor {
		d.fn(t)
	}
}

// AgentContributions collects every plugin's contribution to a claude launch.
func (r *Registry) AgentContributions(l AgentLaunch) AgentContribution {
	r.mu.RLock()
	fns := slices.Clone(r.agent)
	r.mu.RUnlock()
	var out AgentContribution
	for _, c := range fns {
		func() {
			defer func() {
				if v := recover(); v != nil {
					slog.Error("agent contribution panicked", "plugin", c.plugin, "panic", v)
				}
			}()
			out.Merge(c.fn(l))
		}()
	}
	return out
}

// Allowed lists the tools claude may call without asking, by full name.
func (r *Registry) Allowed() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []string
	for _, t := range r.tooldefs {
		if !t.t.Ask {
			out = append(out, "mcp__"+ToolServerName+"__"+t.t.Name)
		}
	}
	return out
}

// Manifests lists the started plugins with what they registered.
func (r *Registry) Manifests() []Manifest {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Manifest, 0, len(r.started))
	for _, e := range r.started {
		m := e.m
		m.API = API
		m.Contributes = r.contributesLocked(m.ID)
		out = append(out, m)
	}
	return out
}

// Features lists the legacy device features the started plugins stand for.
func (r *Registry) Features() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []string
	for _, e := range r.started {
		for _, f := range e.m.Features {
			if !slices.Contains(out, f) {
				out = append(out, f)
			}
		}
	}
	return out
}

func (r *Registry) contributesLocked(id string) Contributes {
	var c Contributes
	for k, s := range r.rpc {
		if s.Plugin == id {
			c.RPC = append(c.RPC, k)
		}
	}
	for _, ch := range r.channels {
		if ch.plugin == id {
			c.Channels = append(c.Channels, ch.prefix)
		}
	}
	for k, s := range r.sessKind {
		if s.plugin == id {
			c.Sessions = append(c.Sessions, k)
		}
	}
	for _, k := range r.kinds {
		if k.plugin == id {
			c.Kinds = append(c.Kinds, k.h.Kind)
		}
	}
	for _, t := range r.tooldefs {
		if t.plugin == id {
			c.Tools = append(c.Tools, t.t.Name)
		}
	}
	sort.Strings(c.RPC)
	sort.Strings(c.Channels)
	sort.Strings(c.Sessions)
	sort.Slice(c.Kinds, func(i, j int) bool { return c.Kinds[i].Kind < c.Kinds[j].Kind })
	return c
}

// Started reports whether a plugin is running.
func (r *Registry) Started(id string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, e := range r.started {
		if e.m.ID == id {
			return true
		}
	}
	return false
}

// host is one plugin's Host.
type host struct {
	r  *Registry
	id string
}

func (h *host) ID() string { return h.id }

func (h *host) HandleRPC(method string, fn RPCFunc, opts ...RPCOption) {
	spec := &RPCSpec{Plugin: h.id, Fn: fn}
	for _, o := range opts {
		o(spec)
	}
	h.r.mu.Lock()
	defer h.r.mu.Unlock()
	if old := h.r.rpc[method]; old != nil && old.Plugin != h.id {
		slog.Error("rpc method registered twice; keeping the first", "method", method, "plugin", h.id, "first", old.Plugin)
		return
	}
	h.r.rpc[method] = spec
}

func (h *host) HandleChannel(prefix string, fn ChannelFunc) {
	h.r.mu.Lock()
	defer h.r.mu.Unlock()
	for _, c := range h.r.channels {
		if c.prefix == prefix {
			slog.Error("channel prefix registered twice; keeping the first", "prefix", prefix, "plugin", h.id, "first", c.plugin)
			return
		}
	}
	h.r.channels = append(h.r.channels, channelReg{plugin: h.id, prefix: prefix, fn: fn})
}

func (h *host) HandleSession(kind string, s SessionHandler) {
	h.r.mu.Lock()
	defer h.r.mu.Unlock()
	if old, ok := h.r.sessKind[kind]; ok && old.plugin != h.id {
		slog.Error("session kind registered twice; keeping the first", "kind", kind, "plugin", h.id, "first", old.plugin)
		return
	}
	h.r.sessKind[kind] = sessionReg{plugin: h.id, h: s}
}

func (h *host) AddKind(k KindHandler) {
	h.r.mu.Lock()
	defer h.r.mu.Unlock()
	if old, ok := h.r.kinds[k.Kind.Kind]; ok && old.plugin != h.id {
		slog.Error("kind registered twice; keeping the first", "kind", k.Kind.Kind, "plugin", h.id, "first", old.plugin)
		return
	}
	h.r.kinds[k.Kind.Kind] = kindReg{plugin: h.id, h: k}
}

func (h *host) AddTools(tools ...Tool) {
	h.r.mu.Lock()
	for _, t := range tools {
		h.r.tooldefs = append(h.r.tooldefs, toolReg{plugin: h.id, t: t})
	}
	h.r.mu.Unlock()
	h.r.syncTools()
}

func (h *host) ContributeAgent(fn func(AgentLaunch) AgentContribution) {
	h.r.mu.Lock()
	defer h.r.mu.Unlock()
	h.r.agent = append(h.r.agent, contribReg{plugin: h.id, fn: fn})
}

func (h *host) DecorateThread(fn func(*protocol.Thread)) {
	h.r.mu.Lock()
	defer h.r.mu.Unlock()
	h.r.decor = append(h.r.decor, decorReg{plugin: h.id, fn: fn})
}

func (h *host) Export(name string, svc any) {
	h.r.mu.Lock()
	defer h.r.mu.Unlock()
	h.r.services[name] = serviceReg{plugin: h.id, svc: svc}
}

func (h *host) Service(name string) (any, bool) {
	h.r.mu.RLock()
	defer h.r.mu.RUnlock()
	s, ok := h.r.services[name]
	return s.svc, ok
}

func (h *host) Emit(event any)                       { h.r.core.Broadcast(event) }
func (h *host) Notify(n protocol.HubNotify)          { h.r.core.Notify(n) }
func (h *host) Bus() *Bus                            { return h.r.bus }
func (h *host) Store() *store.Store                  { return h.r.core.Store() }
func (h *host) KV() KV                               { return NewKV(h.r.core.Store(), h.id, h.r.core.Broadcast) }
func (h *host) Threads() Threads                     { return h.r.core.Threads() }
func (h *host) Info() protocol.DeviceInfo            { return h.r.core.Info() }
func (h *host) DataDir() string                      { return h.r.core.DataDir() }
func (h *host) WebRTC() WebRTC                       { return h.r.core.WebRTC() }
func (h *host) Tools() ToolServer                    { return toolServer{h.r} }
func (h *host) Config() Config                       { return h.r.core.Config() }
func (h *host) Kind(kind string) (KindHandler, bool) { return h.r.Kind(kind) }
func (h *host) Plugins() []Manifest                  { return h.r.Manifests() }
func (h *host) AgentContributions(l AgentLaunch) AgentContribution {
	return h.r.AgentContributions(l)
}

type toolServer struct{ r *Registry }

func (t toolServer) Grant(c mcp.Caller) (string, string, func(), error) { return t.r.tools.Grant(c) }
func (t toolServer) Allowed() []string                                  { return t.r.Allowed() }
