// Package clone is the clone plugin: cloning a repository into a new
// project in the background, with the device's own git credentials or, over
// the hub, a GitHub token the Worker adds for that one clone.
package clone

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
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
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

// Plugin is the clone plugin.
type Plugin struct {
	h      plugin.Host
	clones cloneSet
}

// New makes the clone plugin.
func New() *Plugin { return &Plugin{} }

func (p *Plugin) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID: "clone", Title: "Clone", API: plugin.API, Builtin: true,
		Permissions: []string{plugin.PermExec, plugin.PermFSWrite, plugin.PermSecrets, plugin.PermRemote},
		Features:    []string{protocol.FeatureClone},
	}
}

func (p *Plugin) Start(h plugin.Host) error {
	p.h = h
	h.HandleRPC("projects.clone", plugin.Params(func(c plugin.RPCContext, r struct {
		URL   string `json:"url"`
		Path  string `json:"path"`
		Name  string `json:"name"`
		Token string `json:"token"`
	}) (any, error) {
		// Over WebRTC with the device's own git credentials; the hub's
		// relay adds a GitHub token.
		if !c.Remote {
			r.Token = ""
		}
		proj, _, err := p.cloneProject(r.URL, r.Path, r.Name, r.Token)
		return proj, err
	}), plugin.Remote())
	h.HandleRPC("clones.list", plugin.Params(func(plugin.RPCContext, struct{}) (any, error) {
		return p.clones.list(), nil
	}), plugin.Remote())
	plugin.Subscribe(h.Bus(), plugin.ProjectDeleted, func(id string) {
		p.clones.drop(id)
		p.changed()
	})
	h.Export(plugin.ServiceClone, service{p})
	return nil
}

func (p *Plugin) Stop() {}

type service struct{ p *Plugin }

func (s service) Clone(remote, path, name string) (protocol.Project, <-chan error, error) {
	return s.p.cloneProject(remote, path, name, "")
}

func (p *Plugin) changed() { p.h.Emit(protocol.RPCEvent{Event: protocol.EventClonesChanged}) }

func (p *Plugin) projectsChanged() { p.h.Emit(protocol.RPCEvent{Event: protocol.EventProjectsChanged}) }

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
// background; clones.list and the clones.changed event follow it, and done
// gets its result. path must be missing or an empty directory.
func (s *Plugin) cloneProject(remote, path, name, token string) (proj protocol.Project, done <-chan error, err error) {
	remote = strings.TrimSpace(remote)
	if !validRemote(remote) {
		return protocol.Project{}, nil, errors.New("give an https:// or git@ URL to clone")
	}
	dest, created, err := cloneDest(path)
	if err != nil {
		return protocol.Project{}, nil, err
	}
	p, err := s.h.Store().CreateProject(dest, name)
	if err != nil {
		if created {
			_ = os.Remove(dest)
		}
		return protocol.Project{}, nil, err
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
	s.projectsChanged()
	s.changed()

	result := make(chan error, 1)
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
				s.changed()
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
		s.changed()
		s.projectsChanged() // icons and git state can change
		if err == nil {
			time.AfterFunc(cloneDoneLinger, func() {
				s.clones.drop(p.ID)
				s.changed()
			})
		}
		result <- err
	}()
	return p, result, nil
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
