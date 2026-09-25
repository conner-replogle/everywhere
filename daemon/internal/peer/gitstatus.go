package peer

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/gitx"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

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

// gitDir is where a git request looks: a thread's working directory (its
// worktree, if it has one), or else a project's.
func (s *Server) gitDir(threadID, projectID string) (string, error) {
	if threadID != "" {
		wd, err := s.workdir(threadID)
		return wd.Path, err
	}
	if projectID != "" {
		p, err := s.store.GetProject(projectID)
		return p.Path, err
	}
	return "", errors.New("threadId or projectId is required")
}

// gitStatus reads dir's status and, if origin is stale, fetches it in the
// background (git.changed follows when it's done).
func (s *Server) gitStatus(dir string) (GitStatus, error) {
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

	s.fetches.mu.Lock()
	fs := s.fetches.state(common)
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
	s.fetches.mu.Unlock()

	if start {
		go s.fetch(dir, common)
	}
	return out, nil
}

// fetch fetches origin and tells clients to look again.
func (s *Server) fetch(dir, common string) error {
	ctx, cancel := context.WithTimeout(context.Background(), gitFetchTimeout)
	defer cancel()
	err := gitx.Fetch(ctx, dir)

	s.fetches.mu.Lock()
	fs := s.fetches.state(common)
	fs.running, fs.last = false, time.Now()
	if err != nil {
		fs.failures++
		fs.err = gitx.RedactURL(err.Error())
	} else {
		fs.failures, fs.err, fs.ok = 0, "", fs.last
	}
	s.fetches.mu.Unlock()

	s.broadcast(protocol.EventGitChanged)
	return err
}

// gitAction runs one of the git.* actions on a thread's or project's
// checkout and answers with its status after.
func (s *Server) gitAction(method, threadID, projectID string) (GitStatus, error) {
	dir, err := s.gitDir(threadID, projectID)
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
		s.fetches.mu.Lock()
		fs := s.fetches.state(common)
		busy := fs.running
		fs.running = true
		s.fetches.mu.Unlock()
		if !busy {
			if err := s.fetch(dir, common); err != nil {
				return GitStatus{}, err
			}
		}
	case "git.pull":
		if err := gitx.PullFastForward(ctx, dir); err != nil {
			return GitStatus{}, err
		}
		s.broadcast(protocol.EventGitChanged)
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
		s.broadcast(protocol.EventGitChanged)
	}
	return s.gitStatus(dir)
}
