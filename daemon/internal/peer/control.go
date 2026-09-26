package peer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/agent"
	"github.com/conner-replogle/everywhere/daemon/internal/favicon"
	"github.com/conner-replogle/everywhere/daemon/internal/gitx"
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
			var result any
			var err error
			switch req.Method {
			case "debug.peer":
				result = p.debug()
			case "desktop.start", "desktop.candidate", "desktop.stop":
				result, err = s.callDesktop(p, req.Method, req.Params)
			default:
				result, err = s.call(req.Method, req.Params)
			}
			if err != nil {
				resp.Error = &protocol.RPCError{Message: err.Error()}
			} else {
				resp.Result = result
			}
			out, _ := json.Marshal(resp)
			_ = dc.SendText(string(out))
		}
		// Requests are answered in order, except slow ones (GitHub, starting
		// claude or a desktop capture), which would hold up everything behind them.
		if req.Method == "device.checkUpdate" || req.Method == "device.update" || req.Method == "agent.info" || req.Method == "agent.claudeVersion" || req.Method == "agent.updateClaude" || req.Method == "desktop.start" {
			go handle()
		} else {
			handle()
		}
	})
}

type empty struct{}

func (s *Server) call(method string, raw json.RawMessage) (any, error) {
	var params struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		Path         string `json:"path"`
		ProjectID    string `json:"projectId"`
		Kind         string `json:"kind"`
		ThreadID     string `json:"threadId"`
		State        string `json:"state"`
		KeepWorktree bool   `json:"keepWorktree"`
		Archived     bool   `json:"archived"`
		Force        bool   `json:"force"`
		URL          string `json:"url"`
		// A new claude thread or tab's starting permission mode.
		PermissionMode string `json:"permissionMode"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, fmt.Errorf("bad params: %w", err)
		}
	}

	switch method {
	case "device.info":
		return s.info, nil
	case "desktop.info":
		if s.desktop == nil {
			return protocol.DesktopInfo{Reason: "remote desktop isn't available in this daemon"}, nil
		}
		return s.desktop.Info(), nil
	case "agent.info":
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		return s.agents.Info(ctx), nil
	case "agent.claudeVersion":
		return s.agents.ClaudeVersion(context.Background(), params.Force)
	case "agent.updateClaude":
		return s.agents.UpdateClaude(context.Background())
	case "device.checkUpdate":
		return s.checkUpdate(params.Force)
	case "device.update":
		return s.applyUpdate()

	case "projects.list":
		return s.store.ListProjects()
	case "projects.create":
		p, err := s.store.CreateProject(params.Path, params.Name)
		if err == nil {
			s.broadcast(protocol.EventProjectsChanged)
		}
		return p, err
	case "projects.rename":
		p, err := s.store.RenameProject(params.ID, params.Name)
		if err == nil {
			s.broadcast(protocol.EventProjectsChanged)
		}
		return p, err
	case "projects.clone":
		// Over WebRTC with the device's own git credentials; the hub's
		// relay adds a GitHub token (see Remote).
		return s.cloneProject(params.URL, params.Path, params.Name, "")
	case "clones.list":
		return s.clones.list(), nil
	case "projects.icon":
		p, err := s.store.GetProject(params.ID)
		if err != nil {
			return nil, err
		}
		icon, err := favicon.Find(p.Path)
		if err != nil {
			icon = nil // an unreadable project just has no icon
		}
		return struct {
			Icon *favicon.Icon `json:"icon"`
		}{icon}, nil
	case "projects.delete":
		threads, err := s.withTabs(s.store.ListThreads(params.ID))
		if err != nil {
			return nil, err
		}
		agentThreads := s.agentThreads(threads)
		if err := s.store.DeleteProject(params.ID); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return nil, errors.New("project not found (the home project can't be deleted)")
			}
			return nil, err
		}
		for _, t := range threads {
			s.killThread(t, agentThreads[t.ID], false)
		}
		s.clones.drop(params.ID)
		s.broadcast(protocol.EventProjectsChanged)
		s.broadcast(protocol.EventClonesChanged)
		s.broadcast(protocol.EventThreadsChanged)
		return empty{}, nil

	case "threads.list":
		threads, err := s.store.ListThreads(params.ProjectID)
		for i := range threads {
			s.fillStatus(&threads[i])
		}
		return threads, err
	case "threads.create":
		t, err := s.store.CreateThread(params.ProjectID, params.Name, params.Kind)
		if err == nil {
			err = s.initialMode(t, params.PermissionMode)
		}
		if err == nil {
			s.broadcast(protocol.EventThreadsChanged)
		}
		return t, err
	case "threads.rename":
		t, err := s.store.RenameThread(params.ID, params.Name)
		if err == nil {
			s.fillStatus(&t)
			s.broadcast(protocol.EventThreadsChanged)
		}
		return t, err
	case "threads.archive":
		t, err := s.store.SetThreadArchived(params.ID, params.Archived)
		if err != nil {
			return nil, err
		}
		if params.Archived {
			// History, worktree and claude's session stay; restoring resumes it.
			tabs, _ := s.store.ListTabs(t.ID)
			for _, t := range append(tabs, t) {
				s.stopThread(t)
			}
			s.browsers.Close(t.ID, "The thread was archived", false)
		}
		s.fillStatus(&t)
		s.broadcast(protocol.EventThreadsChanged)
		return t, nil
	case "threads.delete":
		t, err := s.store.GetThread(params.ID)
		if err != nil {
			return nil, err
		}
		threads, err := s.withTabs([]protocol.Thread{t}, nil)
		if err != nil {
			return nil, err
		}
		agentThreads := s.agentThreads(threads)
		if err := s.store.DeleteThread(params.ID); err != nil {
			return nil, err
		}
		for _, t := range threads {
			s.killThread(t, agentThreads[t.ID], params.KeepWorktree)
		}
		s.broadcast(protocol.EventThreadsChanged)
		return empty{}, nil
	case "threads.workdir":
		return s.workdir(params.ID)

	case "tabs.list":
		tabs, err := s.store.ListTabs(params.ThreadID)
		for i := range tabs {
			s.fillStatus(&tabs[i])
		}
		return tabs, err
	case "tabs.create":
		t, err := s.store.CreateTab(params.ThreadID, params.Kind, params.Name)
		if err == nil {
			err = s.initialMode(t, params.PermissionMode)
		}
		if err == nil {
			s.broadcast(protocol.EventThreadsChanged)
		}
		return t, err
	case "tabs.close":
		t, err := s.store.GetThread(params.ID)
		if err != nil {
			return nil, err
		}
		if t.ParentID == "" {
			return nil, errors.New("not a tab")
		}
		agentThreads := s.agentThreads([]protocol.Thread{t})
		if err := s.store.DeleteThread(params.ID); err != nil {
			return nil, err
		}
		s.killThread(t, agentThreads[t.ID], false)
		s.broadcast(protocol.EventThreadsChanged)
		return empty{}, nil
	case "tabs.setState":
		// Not broadcast: only the tab's own view reads it, when it opens.
		if err := s.store.SetTabState(params.ID, params.State); err != nil {
			return nil, err
		}
		return empty{}, nil

	case "fs.listDirs":
		return listDirs(params.Path)
	case "fs.list":
		return listDir(params.Path)

	case "git.status":
		dir, err := s.gitDir(params.ThreadID, params.ProjectID)
		if err != nil {
			return nil, err
		}
		return s.gitStatus(dir)
	case "git.fetch", "git.pull", "git.updateDefault":
		return s.gitAction(method, params.ThreadID, params.ProjectID)
	case "git.info":
		p, err := s.store.GetProject(params.ProjectID)
		if err != nil {
			return nil, err
		}
		return gitInfo(p.Path), nil
	}
	return nil, fmt.Errorf("unknown method %q", method)
}

// initialMode sets a new claude thread's permission mode, if one was asked for.
func (s *Server) initialMode(t protocol.Thread, mode string) error {
	if mode == "" || t.Kind != protocol.ThreadClaude {
		return nil
	}
	if !agent.ValidPermissionMode(mode) {
		return fmt.Errorf("unknown permission mode %q", mode)
	}
	return s.store.SetAgentPermissionMode(t.ID, mode)
}

// fillStatus sets a thread's live fields from its manager.
func (s *Server) fillStatus(t *protocol.Thread) {
	switch t.Kind {
	case protocol.ThreadClaude:
		t.Running, t.AgentStatus = s.agents.Status(t.ID)
	case protocol.ThreadTerminal:
		t.Running = s.terms.Running(t.ID)
	}
}

// withTabs adds the tabs of threads to them.
func (s *Server) withTabs(threads []protocol.Thread, err error) ([]protocol.Thread, error) {
	if err != nil {
		return nil, err
	}
	out := threads
	for _, t := range threads {
		tabs, err := s.store.ListTabs(t.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, tabs...)
	}
	return out, nil
}

// stopThread stops a thread's shell or claude, if it has one.
func (s *Server) stopThread(t protocol.Thread) {
	switch t.Kind {
	case protocol.ThreadClaude:
		s.agents.Kill(t.ID)
	case protocol.ThreadTerminal:
		s.terms.Kill(t.ID)
	}
}

// workdir resolves where a thread works; see store.ThreadWorkdir. In a
// worktree it's the same subdirectory the project is of its repository.
func (s *Server) workdir(threadID string) (protocol.Workdir, error) {
	dir, worktree, err := s.store.ThreadWorkdir(threadID)
	if err != nil || worktree == "" {
		return protocol.Workdir{Path: dir}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	prefix, err := gitx.Prefix(ctx, dir)
	if err != nil {
		return protocol.Workdir{}, err
	}
	return protocol.Workdir{Path: filepath.Join(worktree, prefix), Worktree: true}, nil
}

// shells resolves where a terminal starts for the terminal manager: a tab
// of a claude thread in a worktree starts in that worktree.
type shells struct{ s *Server }

func (r shells) ThreadShell(threadID string) (string, bool, error) {
	dir, had, err := r.s.store.ThreadShell(threadID)
	if err != nil {
		return "", false, err
	}
	// A missing worktree is left for claude to recreate; the shell falls
	// back to the project.
	if wd, err := r.s.workdir(threadID); err == nil && wd.Worktree {
		if _, err := os.Stat(wd.Path); err == nil {
			dir = wd.Path
		}
	}
	return dir, had, nil
}

func (r shells) MarkSpawned(threadID string) error { return r.s.store.MarkSpawned(threadID) }
func (r shells) TouchThread(threadID string) error { return r.s.store.TouchThread(threadID) }

// agentThreads looks up the claude threads among threads, for cleaning up
// after they're deleted.
func (s *Server) agentThreads(threads []protocol.Thread) map[string]store.AgentThread {
	out := map[string]store.AgentThread{}
	for _, t := range threads {
		if t.Kind != protocol.ThreadClaude {
			continue
		}
		if a, err := s.store.AgentThread(t.ID); err == nil {
			out[t.ID] = a
		}
	}
	return out
}

// killThread stops a deleted thread's shell or claude and cleans up after
// it; a is its agent record (claude threads only). A thread's browser page
// goes with the thread or its browser tab.
func (s *Server) killThread(t protocol.Thread, a store.AgentThread, keepWorktree bool) {
	switch {
	case t.Kind == protocol.ThreadClaude:
		s.agents.Remove(t.ID, a, keepWorktree)
	case t.Kind == protocol.ThreadBrowser:
		s.browsers.Close(t.ParentID, "The browser tab was closed", true)
	case t.Kind == protocol.ThreadDesktop:
		if s.desktop != nil {
			s.desktop.CloseTab(t.ID)
		}
	default:
		s.stopThread(t)
	}
	if t.ParentID == "" {
		s.browsers.Close(t.ID, "The thread was deleted", true)
	}
}

// browserKey is whose browser page a thread or tab uses: its thread's.
func (s *Server) browserKey(id string) (string, error) {
	t, err := s.store.GetThread(id)
	if err != nil {
		return "", err
	}
	if t.ParentID != "" {
		return t.ParentID, nil
	}
	return t.ID, nil
}

func gitInfo(dir string) protocol.GitInfo {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	info := protocol.GitInfo{Branches: []string{}}
	if !gitx.IsRepo(ctx, dir) {
		return info
	}
	info.IsRepo = true
	info.Current = gitx.CurrentBranch(ctx, dir)
	if b, err := gitx.Branches(ctx, dir); err == nil {
		info.Branches = b
	}
	return info
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

// listDir lists a directory's entries, directories first.
func listDir(path string) (protocol.FsListing, error) {
	dir, err := store.ResolveDir(path)
	if err != nil {
		return protocol.FsListing{}, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return protocol.FsListing{}, err
	}
	out := protocol.FsListing{Path: dir, Entries: []protocol.FsEntry{}}
	if parent := filepath.Dir(dir); parent != dir {
		out.Parent = &parent
	}
	for _, e := range entries {
		info, err := os.Stat(filepath.Join(dir, e.Name())) // follows symlinks
		if err != nil {
			if info, err = e.Info(); err != nil {
				continue
			}
		}
		out.Entries = append(out.Entries, protocol.FsEntry{
			Name:    e.Name(),
			Dir:     info.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime().UnixMilli(),
		})
	}
	sort.Slice(out.Entries, func(i, j int) bool {
		a, b := out.Entries[i], out.Entries[j]
		if a.Dir != b.Dir {
			return a.Dir
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return out, nil
}
