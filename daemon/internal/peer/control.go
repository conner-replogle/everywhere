package peer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/favicon"
	"github.com/conner-replogle/everywhere/daemon/internal/logring"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

func (s *Server) serveControl(p *peer, dc *webrtc.DataChannel) {
	p.mu.Lock()
	p.control = dc
	p.mu.Unlock()
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		var req protocol.RPCRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			return
		}
		handle := func() {
			resp := protocol.RPCResponse{ID: req.ID}
			result, err := s.plugins.Call(p.ctx, req.Method, plugin.RPCContext{Peer: p}, req.Params)
			if err != nil {
				resp.Error = &protocol.RPCError{Message: err.Error()}
			} else {
				resp.Result = result
			}
			out, _ := json.Marshal(resp)
			sendControl(dc, out)
		}
		// Requests are answered in order, except slow ones (GitHub, starting
		// claude or signing it in, a desktop capture), which would hold up
		// everything behind them.
		if s.plugins.Slow(req.Method) {
			go handle()
		} else {
			handle()
		}
	})
}

// Remote answers requests over the hub. The Worker's own reach only the
// methods registered as Remote (the Claude token, plugins' account
// settings, and cloning with a GitHub token). A connected agent's (agent is
// its name) reach only those registered as Agent, and only while this
// device allows connected agents, a switch the hub can't flip.
// Browsers' requests come over WebRTC.
func (s *Server) Remote(method string, raw json.RawMessage, agent string) (any, error) {
	if agent != "" && (s.AgentsEnabled == nil || !s.AgentsEnabled()) {
		return nil, errors.New("connected agents are turned off on this device; turn them on in the app (Settings → Connected agents) or with `everywhere agents enable` on the device")
	}
	return s.plugins.Call(context.Background(), method, plugin.RPCContext{Remote: true, Agent: agent}, raw)
}

type coreParams struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Path         string `json:"path"`
	ProjectID    string `json:"projectId"`
	Kind         string `json:"kind"`
	ThreadID     string `json:"threadId"`
	State        string `json:"state"`
	KeepWorktree bool   `json:"keepWorktree"`
	// threads.delete: also delete a Scratch thread's folder.
	RemoveScratch bool `json:"removeScratch"`
	// tabs.create: typed into a new terminal tab's shell, not run.
	Input string `json:"input"`
	// threads.create: a new claude thread's first prompt, sent right away.
	Prompt   string `json:"prompt"`
	Archived bool   `json:"archived"`
	Force    bool   `json:"force"`
	// device.setAgents
	Enabled bool `json:"enabled"`
	// A new claude thread or tab's starting permission mode.
	PermissionMode string `json:"permissionMode"`
	// debug.logs: how many of the newest lines (all that are kept if 0).
	Lines int `json:"lines"`
}

// registerCore registers the core's own methods.
func (s *Server) registerCore(h plugin.Host) {
	rpc := func(method string, fn func(c plugin.RPCContext, p coreParams) (any, error), opts ...plugin.RPCOption) {
		h.HandleRPC(method, plugin.Params(fn), opts...)
	}

	rpc("device.info", func(plugin.RPCContext, coreParams) (any, error) { return s.Info(), nil })
	rpc("device.checkUpdate", func(_ plugin.RPCContext, p coreParams) (any, error) { return s.checkUpdate(p.Force) }, plugin.Slow())
	rpc("device.update", func(plugin.RPCContext, coreParams) (any, error) { return s.applyUpdate() }, plugin.Slow())
	// Connected agents' switch on this device. Reading it is open to the
	// Worker (so it can say why a device can't be reached); setting it only
	// to a browser over WebRTC, never the hub.
	rpc("device.agents", func(plugin.RPCContext, coreParams) (any, error) {
		return protocol.AgentsInfo{Enabled: s.AgentsEnabled != nil && s.AgentsEnabled()}, nil
	}, plugin.Remote())
	rpc("device.setAgents", func(c plugin.RPCContext, p coreParams) (any, error) {
		if c.Remote || c.Peer == nil || s.SetAgents == nil {
			return nil, errors.New("connected agents can only be turned on or off from the app or on the device")
		}
		if err := s.SetAgents(p.Enabled); err != nil {
			return nil, err
		}
		return protocol.AgentsInfo{Enabled: s.AgentsEnabled()}, nil
	})
	h.HandleRPC("debug.peer", func(_ context.Context, c plugin.RPCContext, _ json.RawMessage) (any, error) {
		p, ok := c.Peer.(*peer)
		if !ok {
			return nil, errors.New("debug.peer needs a browser connection")
		}
		return p.debug(), nil
	})
	rpc("debug.logs", func(_ plugin.RPCContext, p coreParams) (any, error) { return logring.Default.Tail(p.Lines), nil })

	rpc("projects.list", func(plugin.RPCContext, coreParams) (any, error) { return s.store.ListProjects() }, plugin.Agent())
	rpc("projects.create", func(_ plugin.RPCContext, p coreParams) (any, error) {
		proj, err := s.store.CreateProject(p.Path, p.Name)
		if err == nil {
			s.broadcast(protocol.EventProjectsChanged)
		}
		return proj, err
	}, plugin.Agent())
	rpc("projects.rename", func(_ plugin.RPCContext, p coreParams) (any, error) {
		proj, err := s.store.RenameProject(p.ID, p.Name)
		if err == nil {
			s.broadcast(protocol.EventProjectsChanged)
		}
		return proj, err
	})
	rpc("projects.icon", func(_ plugin.RPCContext, p coreParams) (any, error) {
		proj, err := s.store.GetProject(p.ID)
		if err != nil {
			return nil, err
		}
		icon, err := favicon.Find(proj.Path)
		if err != nil {
			icon = nil // an unreadable project just has no icon
		}
		return struct {
			Icon *favicon.Icon `json:"icon"`
		}{icon}, nil
	})
	rpc("projects.delete", func(_ plugin.RPCContext, p coreParams) (any, error) { return s.deleteProject(p.ID) })

	rpc("threads.list", func(_ plugin.RPCContext, p coreParams) (any, error) {
		threads, err := s.store.ListThreads(p.ProjectID)
		for i := range threads {
			s.plugins.Decorate(&threads[i])
		}
		return threads, err
	}, plugin.Agent())
	rpc("threads.get", func(_ plugin.RPCContext, p coreParams) (any, error) {
		return s.Threads().Live(p.ThreadID)
	}, plugin.Agent())
	rpc("threads.create", func(c plugin.RPCContext, p coreParams) (any, error) {
		kind := p.Kind
		if kind == "" {
			kind = protocol.ThreadTerminal
		}
		k, ok := s.plugins.Kind(kind)
		if !ok || !k.Thread {
			return nil, fmt.Errorf("unknown thread kind %q", kind)
		}
		if c.Agent != "" {
			// Connected agents start conversations with coding agents, whose
			// permission prompts come to the user; never a shell.
			if kind != protocol.ThreadClaude && k.View != "agent" {
				return nil, fmt.Errorf("connected agents can't start %s threads", kind)
			}
			if p.PermissionMode == "bypassPermissions" {
				return nil, errors.New("connected agents can't start a thread that skips permission prompts")
			}
		}
		t, err := s.store.CreateThread(p.ProjectID, p.Name, kind)
		if err != nil {
			return nil, err
		}
		s.broadcast(protocol.EventThreadsChanged)
		if k.Created != nil {
			err = k.Created(t, plugin.CreateParams{PermissionMode: p.PermissionMode, Prompt: p.Prompt})
		}
		return t, err
}, plugin.Agent())
	rpc("threads.rename", func(_ plugin.RPCContext, p coreParams) (any, error) {
		t, err := s.store.RenameThread(p.ID, p.Name)
		if err == nil {
			s.plugins.Decorate(&t)
			s.broadcast(protocol.EventThreadsChanged)
		}
		return t, err
}, plugin.Agent())
	rpc("threads.archive", func(_ plugin.RPCContext, p coreParams) (any, error) {
		t, err := s.store.SetThreadArchived(p.ID, p.Archived)
		if err != nil {
			return nil, err
		}
		if p.Archived {
			// History, worktree and claude's session stay; restoring resumes it.
			tabs, _ := s.store.ListTabs(t.ID)
			for _, tt := range append(tabs, t) {
				if k, ok := s.plugins.Kind(tt.Kind); ok && k.Stop != nil {
					k.Stop(tt)
				}
			}
			plugin.Publish(s.plugins.Bus(), plugin.ThreadArchived, plugin.ThreadEvent{Thread: t, Tabs: tabs})
		}
		s.plugins.Decorate(&t)
		s.broadcast(protocol.EventThreadsChanged)
		return t, nil
	}, plugin.Agent())
	rpc("threads.delete", func(_ plugin.RPCContext, p coreParams) (any, error) {
		t, err := s.store.GetThread(p.ID)
		if err != nil {
			return nil, err
		}
		return plugin.Empty{}, s.deleteThread(t, plugin.DeleteParams{KeepWorktree: p.KeepWorktree, RemoveScratch: p.RemoveScratch})
	})
	rpc("threads.workdir", func(_ plugin.RPCContext, p coreParams) (any, error) { return s.Threads().Workdir(p.ID) })

	rpc("tabs.list", func(_ plugin.RPCContext, p coreParams) (any, error) {
		tabs, err := s.store.ListTabs(p.ThreadID)
		for i := range tabs {
			s.plugins.Decorate(&tabs[i])
		}
		return tabs, err
	})
	rpc("tabs.create", func(_ plugin.RPCContext, p coreParams) (any, error) {
		k, ok := s.plugins.Kind(p.Kind)
		if !ok {
			return nil, fmt.Errorf("unknown tab kind %q", p.Kind)
		}
		t, err := s.store.CreateTab(p.ThreadID, p.Kind, p.Name)
		if err != nil {
			return nil, err
		}
		if k.Created != nil {
			err = k.Created(t, plugin.CreateParams{PermissionMode: p.PermissionMode, Input: p.Input})
		}
		s.broadcast(protocol.EventThreadsChanged)
		return t, err
	})
	rpc("tabs.close", func(_ plugin.RPCContext, p coreParams) (any, error) {
		t, err := s.store.GetThread(p.ID)
		if err != nil {
			return nil, err
		}
		if t.ParentID == "" {
			return nil, errors.New("not a tab")
		}
		return plugin.Empty{}, s.deleteThread(t, plugin.DeleteParams{})
	})
	rpc("tabs.setState", func(_ plugin.RPCContext, p coreParams) (any, error) {
		// Not broadcast: only the tab's own view reads it, when it opens.
		if err := s.store.SetTabState(p.ID, p.State); err != nil {
			return nil, err
		}
		return plugin.Empty{}, nil
	})

	rpc("fs.listDirs", func(_ plugin.RPCContext, p coreParams) (any, error) { return listDirs(p.Path) }, plugin.Agent())
	rpc("fs.mkdir", func(_ plugin.RPCContext, p coreParams) (any, error) { return makeDir(p.Path, p.Name) })
}

// deleteThread deletes a thread with its tabs, or one tab: each kind
// cleans up after its own (reading what it needs before the rows go), then
// plugins hear of it.
func (s *Server) deleteThread(t protocol.Thread, d plugin.DeleteParams) error {
	var tabs []protocol.Thread
	if t.ParentID == "" {
		var err error
		if tabs, err = s.store.ListTabs(t.ID); err != nil {
			return err
		}
	}
	plugin.Publish(s.plugins.Bus(), plugin.ThreadDeleting, plugin.ThreadEvent{Thread: t, Tabs: tabs, Delete: d})
	after := s.beforeDelete(append([]protocol.Thread{t}, tabs...), d)
	if err := s.store.DeleteThread(t.ID); err != nil {
		return err
	}
	s.dropState(append([]protocol.Thread{t}, tabs...), "")
	for _, fn := range after {
		fn()
	}
	var errs []error
	plugin.Publish(s.plugins.Bus(), plugin.ThreadDeleted, plugin.ThreadEvent{
		Thread: t, Tabs: tabs, Delete: d, Fail: func(err error) { errs = append(errs, err) },
	})
	s.broadcast(protocol.EventThreadsChanged)
	return errors.Join(errs...)
}

// dropState deletes plugins' state kept for deleted threads (and a deleted
// project).
func (s *Server) dropState(threads []protocol.Thread, projectID string) {
	for _, t := range threads {
		if err := s.store.KVDeleteScope("thread:" + t.ID); err != nil {
			slog.Warn("deleting plugin state", "thread", t.ID, "err", err)
		}
	}
	if projectID != "" {
		if err := s.store.KVDeleteScope("project:" + projectID); err != nil {
			slog.Warn("deleting plugin state", "project", projectID, "err", err)
		}
	}
}

// beforeDelete runs each thread's kind's Delete hook, returning what to do
// once the rows are gone.
func (s *Server) beforeDelete(threads []protocol.Thread, d plugin.DeleteParams) []func() {
	var after []func()
	for _, t := range threads {
		if k, ok := s.plugins.Kind(t.Kind); ok && k.Delete != nil {
			if fn := k.Delete(t, d); fn != nil {
				after = append(after, fn)
			}
		}
	}
	return after
}

func (s *Server) deleteProject(id string) (any, error) {
	threads, err := s.store.ListThreads(id)
	if err != nil {
		return nil, err
	}
	tabsOf := map[string][]protocol.Thread{}
	all := threads
	for _, t := range threads {
		tabs, err := s.store.ListTabs(t.ID)
		if err != nil {
			return nil, err
		}
		tabsOf[t.ID] = tabs
		all = append(all, tabs...)
	}
	for _, t := range threads {
		plugin.Publish(s.plugins.Bus(), plugin.ThreadDeleting, plugin.ThreadEvent{Thread: t, Tabs: tabsOf[t.ID]})
	}
	after := s.beforeDelete(all, plugin.DeleteParams{})
	if err := s.store.DeleteProject(id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, errors.New("project not found (the home and Scratch projects can't be deleted)")
		}
		return nil, err
	}
	s.dropState(all, id)
	for _, fn := range after {
		fn()
	}
	for _, t := range threads {
		plugin.Publish(s.plugins.Bus(), plugin.ThreadDeleted, plugin.ThreadEvent{Thread: t, Tabs: tabsOf[t.ID], Fail: func(error) {}})
	}
	plugin.Publish(s.plugins.Bus(), plugin.ProjectDeleted, id)
	s.broadcast(protocol.EventProjectsChanged)
	s.broadcast(protocol.EventThreadsChanged)
	return plugin.Empty{}, nil
}

// listDirs lists subdirectory names only; file contents are never read.
func listDirs(path string) (protocol.DirListing, error) {
	if strings.TrimSpace(path) == "" {
		path = "~"
	}
	dir, err := store.ResolveDir(path)
	if err != nil {
		return protocol.DirListing{}, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return protocol.DirListing{}, err
	}
	out := protocol.DirListing{Path: dir, Dirs: []string{}}
	if parent := filepath.Dir(dir); parent != dir {
		out.Parent = &parent
	}
	for _, e := range entries {
		isDir := e.IsDir()
		if e.Type()&os.ModeSymlink != 0 {
			if info, err := os.Stat(filepath.Join(dir, e.Name())); err == nil {
				isDir = info.IsDir()
			}
		}
		if isDir {
			out.Dirs = append(out.Dirs, e.Name())
		}
	}
	sort.Slice(out.Dirs, func(i, j int) bool {
		a, b := out.Dirs[i], out.Dirs[j]
		// Hidden directories last.
		if ha, hb := strings.HasPrefix(a, "."), strings.HasPrefix(b, "."); ha != hb {
			return hb
		}
		return strings.ToLower(a) < strings.ToLower(b)
	})
	return out, nil
}

// makeDir creates the folder name in the directory path and lists it.
func makeDir(path, name string) (protocol.DirListing, error) {
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
		return protocol.DirListing{}, fmt.Errorf("%q isn't a folder name", name)
	}
	dir, err := store.ResolveDir(path)
	if err != nil {
		return protocol.DirListing{}, err
	}
	created := filepath.Join(dir, name)
	if err := os.Mkdir(created, 0o755); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return protocol.DirListing{}, fmt.Errorf("%s already exists", created)
		}
		return protocol.DirListing{}, err
	}
	return listDirs(created)
}
