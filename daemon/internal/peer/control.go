package peer

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pion/webrtc/v4"

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
		resp := protocol.RPCResponse{ID: req.ID}
		var result any
		var err error
		if req.Method == "debug.peer" {
			result = p.debug()
		} else {
			result, err = s.call(req.Method, req.Params)
		}
		if err != nil {
			resp.Error = &protocol.RPCError{Message: err.Error()}
		} else {
			resp.Result = result
		}
		out, _ := json.Marshal(resp)
		_ = dc.SendText(string(out))
	})
}

type empty struct{}

func (s *Server) call(method string, raw json.RawMessage) (any, error) {
	var params struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Path      string `json:"path"`
		ProjectID string `json:"projectId"`
		Kind      string `json:"kind"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &params); err != nil {
			return nil, fmt.Errorf("bad params: %w", err)
		}
	}

	switch method {
	case "device.info":
		return s.info, nil

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
	case "projects.delete":
		threads, err := s.store.ListThreads(params.ID)
		if err != nil {
			return nil, err
		}
		if err := s.store.DeleteProject(params.ID); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return nil, errors.New("project not found (the home project can't be deleted)")
			}
			return nil, err
		}
		for _, t := range threads {
			s.killThread(t)
		}
		s.broadcast(protocol.EventProjectsChanged)
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
	case "threads.delete":
		t, err := s.store.GetThread(params.ID)
		if err != nil {
			return nil, err
		}
		if err := s.store.DeleteThread(params.ID); err != nil {
			return nil, err
		}
		s.killThread(t)
		s.broadcast(protocol.EventThreadsChanged)
		return empty{}, nil

	case "fs.listDirs":
		return listDirs(params.Path)
	}
	return nil, fmt.Errorf("unknown method %q", method)
}

// fillStatus sets a thread's live fields from its manager.
func (s *Server) fillStatus(t *protocol.Thread) {
	if t.Kind == protocol.ThreadClaude {
		t.Running, t.AgentStatus = s.agents.Status(t.ID)
	} else {
		t.Running = s.terms.Running(t.ID)
	}
}

func (s *Server) killThread(t protocol.Thread) {
	if t.Kind == protocol.ThreadClaude {
		s.agents.Kill(t.ID)
	} else {
		s.terms.Kill(t.ID)
	}
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
