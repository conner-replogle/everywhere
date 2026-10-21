package plugin

import (
	"context"
	"errors"
	"path/filepath"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/gitx"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

// StoreThreads implements Threads on the daemon's store.
type StoreThreads struct {
	Store *store.Store
	// OnChange tells browsers the thread list changed.
	OnChange func()
	// Decorate fills a thread's live fields.
	Decorate func(*protocol.Thread)
}

// Get finds a thread or tab.
func (t StoreThreads) Get(id string) (protocol.Thread, error) {
	th, err := t.Store.GetThread(id)
	if errors.Is(err, store.ErrNotFound) {
		return th, errors.New("thread not found")
	}
	return th, err
}

// Live finds a thread or tab with its live fields (running, status,
// counts), as threads.list reports it.
func (t StoreThreads) Live(id string) (protocol.Thread, error) {
	th, err := t.Get(id)
	if err == nil && t.Decorate != nil {
		t.Decorate(&th)
	}
	return th, err
}

// Workdir resolves where a thread works; see store.ThreadWorkdir. In a
// worktree it's the same subdirectory the project is of its repository.
func (t StoreThreads) Workdir(id string) (protocol.Workdir, error) {
	dir, worktree, err := t.Store.ThreadWorkdir(id)
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

// Owner is the thread a thread or tab belongs to.
func (t StoreThreads) Owner(id string) (string, error) {
	th, err := t.Store.GetThread(id)
	if err != nil {
		return "", err
	}
	if th.ParentID != "" {
		return th.ParentID, nil
	}
	return th.ID, nil
}

// Changed tells browsers the thread list changed.
func (t StoreThreads) Changed() {
	if t.OnChange != nil {
		t.OnChange()
	}
}

// Dir is a thread's working directory (its worktree, if it has one), or
// else a project's.
func Dir(h Host, threadID, projectID string) (string, error) {
	if threadID != "" {
		wd, err := h.Threads().Workdir(threadID)
		return wd.Path, err
	}
	if projectID != "" {
		p, err := h.Store().GetProject(projectID)
		return p.Path, err
	}
	return "", errors.New("threadId or projectId is required")
}
