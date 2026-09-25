package peer

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/agent"
	"github.com/conner-replogle/everywhere/daemon/internal/code"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

const (
	codeExecDefault = 30 * time.Second
	codeExecMax     = 120 * time.Second
	codeSearchLimit = 20 * time.Second
	// How long the login shell's environment is reused before it's read again.
	codeEnvTTL = 5 * time.Minute
)

// codeEnv caches the user's login-shell environment for commands run over
// MCP, so they find what a terminal would (mise, nvm, ~/.local/bin, …).
type codeEnv struct {
	mu  sync.Mutex
	env []string
	at  time.Time
}

func (c *codeEnv) get() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.env == nil || time.Since(c.at) > codeEnvTTL {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if env := agent.LoginEnv(ctx); env != nil {
			c.env, c.at = env, time.Now()
		}
	}
	return c.env
}

// codeParams are what every code.* request can carry: where it's rooted
// (a thread's working directory, a project, or an explicit directory) and
// the path it's about.
type codeParams struct {
	ThreadID  string `json:"threadId"`
	ProjectID string `json:"projectId"`
	Cwd       string `json:"cwd"`
	Path      string `json:"path"`
}

// base is the directory relative paths are resolved against.
func (s *Server) codeBase(p codeParams) (string, error) {
	switch {
	case p.Cwd != "":
		return store.ResolveDir(p.Cwd)
	case p.ThreadID != "" || p.ProjectID != "":
		return s.gitDir(p.ThreadID, p.ProjectID)
	default:
		return store.ResolveDir("~")
	}
}

// resolve turns a path into an absolute one: "~/x" from home, "x" from base.
func (s *Server) codePath(p codeParams, required bool) (string, error) {
	path := strings.TrimSpace(p.Path)
	if path == "" {
		if required {
			return "", errors.New("path is required")
		}
		return s.codeBase(p)
	}
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, strings.TrimPrefix(path, "~")), nil
	}
	if filepath.IsAbs(path) {
		return filepath.Clean(path), nil
	}
	base, err := s.codeBase(p)
	if err != nil {
		return "", err
	}
	return filepath.Join(base, path), nil
}

// codeCall answers the code.* requests the hub relays for MCP agents.
func (s *Server) codeCall(method string, raw json.RawMessage) (any, error) {
	var p struct {
		codeParams
		Command    string `json:"command"`
		Stdin      string `json:"stdin"`
		TimeoutMs  int    `json:"timeoutMs"`
		Offset     int    `json:"offset"`
		Limit      int    `json:"limit"`
		Content    string `json:"content"`
		Old        string `json:"old"`
		New        string `json:"new"`
		All        bool   `json:"all"`
		Pattern    string `json:"pattern"`
		Glob       string `json:"glob"`
		IgnoreCase bool   `json:"ignoreCase"`
		FilesOnly  bool   `json:"filesOnly"`
		Context    int    `json:"context"`
	}
	if err := unmarshal(raw, &p); err != nil {
		return nil, err
	}
	switch method {
	case "code.exec":
		dir, err := s.codePath(p.codeParams, false)
		if err != nil {
			return nil, err
		}
		timeout := codeExecDefault
		if p.TimeoutMs > 0 {
			timeout = min(time.Duration(p.TimeoutMs)*time.Millisecond, codeExecMax)
		}
		return code.Exec(context.Background(), dir, p.Command, p.Stdin, timeout, s.codeEnv.get())
	case "code.read":
		path, err := s.codePath(p.codeParams, true)
		if err != nil {
			return nil, err
		}
		return code.Read(path, p.Offset, p.Limit)
	case "code.write":
		path, err := s.codePath(p.codeParams, true)
		if err != nil {
			return nil, err
		}
		return code.Write(path, p.Content)
	case "code.edit":
		path, err := s.codePath(p.codeParams, true)
		if err != nil {
			return nil, err
		}
		return code.Edit(path, p.Old, p.New, p.All)
	case "code.glob":
		dir, err := s.codePath(p.codeParams, false)
		if err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), codeSearchLimit)
		defer cancel()
		return code.Glob(ctx, dir, p.Pattern, p.Limit)
	case "code.grep":
		dir, err := s.codePath(p.codeParams, false)
		if err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), codeSearchLimit)
		defer cancel()
		return code.Grep(ctx, dir, code.GrepOptions{
			Pattern: p.Pattern, Glob: p.Glob, IgnoreCase: p.IgnoreCase, FilesOnly: p.FilesOnly, Context: p.Context, Limit: p.Limit,
		}, s.codeEnv.get())
	}
	return nil, errors.New("unknown code method")
}
