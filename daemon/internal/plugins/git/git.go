// Package git is the git plugin: a thread's or project's checkout status
// (keeping origin fetched while someone looks), pulling, and branches for
// the workspace picker.
package git

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/gitx"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// Plugin is the git plugin.
type Plugin struct {
	h       plugin.Host
	fetches gitFetches
}

// New makes the git plugin.
func New() *Plugin { return &Plugin{} }

func (p *Plugin) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID: "git", Title: "Git", API: plugin.API, Builtin: true,
		Permissions: []string{plugin.PermExec, plugin.PermRemote},
		Features:    []string{protocol.FeatureGitStatus},
	}
}

type params struct {
	ThreadID  string `json:"threadId"`
	ProjectID string `json:"projectId"`
}

func (p *Plugin) Start(h plugin.Host) error {
	p.h = h
	h.HandleRPC("git.status", plugin.Params(func(_ plugin.RPCContext, ps params) (any, error) {
		dir, err := p.dir(ps.ThreadID, ps.ProjectID)
		if err != nil {
			return nil, err
		}
		return p.status(dir)
	}), plugin.Remote())
	for _, m := range []string{"git.fetch", "git.pull", "git.updateDefault"} {
		h.HandleRPC(m, plugin.Params(func(_ plugin.RPCContext, ps params) (any, error) {
			return p.action(m, ps.ThreadID, ps.ProjectID)
		}), plugin.Remote())
	}
	h.HandleRPC("git.info", plugin.Params(func(_ plugin.RPCContext, ps params) (any, error) {
		proj, err := h.Store().GetProject(ps.ProjectID)
		if err != nil {
			return nil, err
		}
		return Info(proj.Path), nil
	}), plugin.Remote())
	return nil
}

func (p *Plugin) Stop() {}

func (p *Plugin) changed() { p.h.Emit(protocol.RPCEvent{Event: protocol.EventGitChanged}) }

// Info lists a directory's branches, for the workspace picker.
func Info(dir string) protocol.GitInfo {
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

const (
	// How stale origin's refs may get while someone is looking at the repo.
	gitFetchEvery = time.Minute
	// A failing fetch (offline, no credentials) backs off to this.
	gitFetchBackoffMax = 15 * time.Minute
	gitFetchTimeout    = 30 * time.Second
	gitStatusTimeout   = 10 * time.Second
)

// GitStatus is the result of git.status and the git actions.
type GitStatus struct {
	gitx.Status
	// FetchedAt is when origin was last fetched (Unix ms), 0 if not yet.
	FetchedAt  int64  `json:"fetchedAt,omitempty"`
	FetchError string `json:"fetchError,omitempty"`
	Fetching   bool   `json:"fetching,omitempty"`
}

// gitFetches keeps origin fetched for repos being looked at, one entry per
// repository (shared by its worktrees).
type gitFetches struct {
	mu    sync.Mutex
	repos map[string]*fetchState
}

type fetchState struct {
	running  bool
	last     time.Time // last attempt's end
	ok       time.Time // last success
	failures int
	err      string
}

func (f *gitFetches) state(common string) *fetchState {
	if f.repos == nil {
		f.repos = map[string]*fetchState{}
	}
	st := f.repos[common]
	if st == nil {
		st = &fetchState{}
		f.repos[common] = st
	}
	return st
}

// dir is where a git request looks: a thread's working directory (its
// worktree, if it has one), or else a project's.
func (p *Plugin) dir(threadID, projectID string) (string, error) {
	return plugin.Dir(p.h, threadID, projectID)
}

// gitStatus reads dir's status and, if origin is stale, fetches it in the
// background (git.changed follows when it's done).
func (p *Plugin) status(dir string) (GitStatus, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitStatusTimeout)
	defer cancel()
	st, err := gitx.ReadStatus(ctx, dir)
	out := GitStatus{Status: st}
	if err != nil || !st.IsRepo {
		return out, err
	}
	common, err := gitx.CommonDir(ctx, dir)
	if err != nil || !gitx.HasRemote(ctx, dir, "origin") {
		return out, nil
	}

	p.fetches.mu.Lock()
	fs := p.fetches.state(common)
	wait := gitFetchEvery
	for i := 0; i < fs.failures && wait < gitFetchBackoffMax; i++ {
		wait *= 2
	}
	start := !fs.running && time.Since(fs.last) >= min(wait, gitFetchBackoffMax)
	if start {
		fs.running = true
	}
	out.Fetching, out.FetchError = fs.running, fs.err
	if !fs.ok.IsZero() {
		out.FetchedAt = fs.ok.UnixMilli()
	}
	p.fetches.mu.Unlock()

	if start {
		go p.fetch(dir, common)
	}
	return out, nil
}

// fetch fetches origin and tells clients to look again.
func (p *Plugin) fetch(dir, common string) error {
	ctx, cancel := context.WithTimeout(context.Background(), gitFetchTimeout)
	defer cancel()
	err := gitx.Fetch(ctx, dir)

	p.fetches.mu.Lock()
	fs := p.fetches.state(common)
	fs.running, fs.last = false, time.Now()
	if err != nil {
		fs.failures++
		fs.err = gitx.RedactURL(err.Error())
	} else {
		fs.failures, fs.err, fs.ok = 0, "", fs.last
	}
	p.fetches.mu.Unlock()

	p.changed()
	return err
}

// gitAction runs one of the git.* actions on a thread's or project's
// checkout and answers with its status after.
func (p *Plugin) action(method, threadID, projectID string) (GitStatus, error) {
	dir, err := p.dir(threadID, projectID)
	if err != nil {
		return GitStatus{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), gitFetchTimeout)
	defer cancel()
	switch method {
	case "git.fetch":
		common, err := gitx.CommonDir(ctx, dir)
		if err != nil {
			return GitStatus{}, err
		}
		p.fetches.mu.Lock()
		fs := p.fetches.state(common)
		busy := fs.running
		fs.running = true
		p.fetches.mu.Unlock()
		if !busy {
			if err := p.fetch(dir, common); err != nil {
				return GitStatus{}, err
			}
		}
	case "git.pull":
		if err := gitx.PullFastForward(ctx, dir); err != nil {
			return GitStatus{}, err
		}
		p.changed()
	case "git.updateDefault":
		st, err := gitx.ReadStatus(ctx, dir)
		if err != nil {
			return GitStatus{}, err
		}
		switch {
		case st.DefaultBranch == "":
			return GitStatus{}, errors.New("origin has no default branch")
		case st.Branch == st.DefaultBranch:
			err = gitx.PullFastForward(ctx, dir)
		default:
			err = gitx.FastForwardBranch(ctx, dir, st.DefaultBranch)
		}
		if err != nil {
			return GitStatus{}, err
		}
		p.changed()
	}
	return p.status(dir)
}
