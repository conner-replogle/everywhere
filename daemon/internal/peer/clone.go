package peer

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/gitx"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

const (
	// A finished clone's status lingers so the web app sees it end.
	cloneDoneLinger = 30 * time.Second
	// Progress is broadcast at most this often.
	cloneProgressEvery = 250 * time.Millisecond
	cloneTimeout       = time.Hour
)

// cloneSet tracks clones into new projects: running, just done, or failed
// (until the project is deleted). Memory only; a restart forgets them.
type cloneSet struct {
	mu   sync.Mutex
	jobs map[string]*protocol.CloneStatus // by project id
}

func (c *cloneSet) list() []protocol.CloneStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]protocol.CloneStatus, 0, len(c.jobs))
	for _, j := range c.jobs {
		out = append(out, *j)
	}
	return out
}

func (c *cloneSet) update(id string, fn func(*protocol.CloneStatus)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if j := c.jobs[id]; j != nil {
		fn(j)
	}
}

func (c *cloneSet) drop(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.jobs, id)
}

// cloneProject creates a project at path and clones remote into it in the
// background; clones.list and the clones.changed event follow it. path must
// be missing or an empty directory.
func (s *Server) cloneProject(remote, path, name, token string) (protocol.Project, error) {
	remote = strings.TrimSpace(remote)
	if !validRemote(remote) {
		return protocol.Project{}, errors.New("give an https:// or git@ URL to clone")
	}
	dest, created, err := cloneDest(path)
	if err != nil {
		return protocol.Project{}, err
	}
	p, err := s.store.CreateProject(dest, name)
	if err != nil {
		if created {
			_ = os.Remove(dest)
		}
		return protocol.Project{}, err
	}
	job := &protocol.CloneStatus{
		ProjectID: p.ID, URL: gitx.RedactURL(remote), Path: dest,
		Phase: "running", Stage: "connecting", Percent: -1, StartedAt: time.Now().UnixMilli(),
	}
	s.clones.mu.Lock()
	if s.clones.jobs == nil {
		s.clones.jobs = map[string]*protocol.CloneStatus{}
	}
	s.clones.jobs[p.ID] = job
	s.clones.mu.Unlock()
	s.broadcast(protocol.EventProjectsChanged)
	s.broadcast(protocol.EventClonesChanged)

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), cloneTimeout)
		defer cancel()
		var last time.Time
		err := gitx.Clone(ctx, remote, dest, token, func(pr gitx.CloneProgress) {
			s.clones.update(p.ID, func(j *protocol.CloneStatus) {
				j.Stage, j.Percent, j.Detail = pr.Stage, pr.Percent, pr.Detail
			})
			if time.Since(last) >= cloneProgressEvery {
				last = time.Now()
				s.broadcast(protocol.EventClonesChanged)
			}
		})
		s.clones.update(p.ID, func(j *protocol.CloneStatus) {
			j.EndedAt = time.Now().UnixMilli()
			if err != nil {
				j.Phase, j.Error = "failed", err.Error()
			} else {
				j.Phase, j.Percent, j.Detail = "done", 100, ""
			}
		})
		if err != nil {
			// git removes what it wrote; the empty folder stays as the project.
			_ = os.MkdirAll(dest, 0o755)
		}
		s.broadcast(protocol.EventClonesChanged)
		s.broadcast(protocol.EventProjectsChanged) // icons and git state can change
		if err == nil {
			time.AfterFunc(cloneDoneLinger, func() {
				s.clones.drop(p.ID)
				s.broadcast(protocol.EventClonesChanged)
			})
		}
	}()
	return p, nil
}

func validRemote(u string) bool {
	if strings.HasPrefix(u, "-") || strings.ContainsAny(u, " \t\n") {
		return false
	}
	return strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "ssh://") ||
		(strings.HasPrefix(u, "git@") && strings.Contains(u, ":"))
}

// cloneDest resolves a clone's destination and makes sure it exists and is
// empty, creating it (and its parents) if needed.
func cloneDest(path string) (dest string, created bool, err error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", false, errors.New("pick a folder to clone into")
	}
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", false, err
		}
		path = filepath.Join(home, strings.TrimPrefix(path, "~"))
	}
	dest, err = filepath.Abs(path)
	if err != nil {
		return "", false, err
	}
	entries, err := os.ReadDir(dest)
	switch {
	case errors.Is(err, os.ErrNotExist):
		if err := os.MkdirAll(dest, 0o755); err != nil {
			return "", false, err
		}
		created = true
	case err != nil:
		return "", false, err
	case len(entries) > 0:
		return "", false, fmt.Errorf("%s already exists and isn't empty", dest)
	}
	dest, err = store.ResolveDir(dest)
	return dest, created, err
}
