// Package terminal is the terminal plugin: terminal threads and tabs, and
// the term: channel.
package terminal

import (
	"context"
	"fmt"
	"os"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/termchan"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/term"
)

// RemoteCols and RemoteRows are the size of a shell started by typing into
// it (a new tab's input); the browser's attach resizes it.
const RemoteCols, RemoteRows = 120, 32

// Plugin is the terminal plugin.
type Plugin struct {
	h     plugin.Host
	terms *term.Manager
}

// New makes the terminal plugin.
func New() *Plugin { return &Plugin{} }

func (p *Plugin) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID: "terminal", Title: "Terminal", API: plugin.API, Builtin: true,
		Permissions: []string{plugin.PermPTY},
	}
}

func (p *Plugin) Start(h plugin.Host) error {
	p.h = h
	p.terms = term.NewManager(shells{h}, h.Threads().Changed)
	h.Export(plugin.ServiceTerminal, service{p.terms})
	h.HoldRestart(func() string {
		switch n := p.terms.Busy(); n {
		case 0:
			return ""
		case 1:
			return "a terminal is running a command"
		default:
			return fmt.Sprintf("%d terminals are running commands", n)
		}
	})
	h.AddKind(plugin.KindHandler{
		Kind: plugin.Kind{Kind: protocol.ThreadTerminal, Thread: true},
		Created: func(t protocol.Thread, c plugin.CreateParams) error {
			if c.Input == "" || t.ParentID == "" {
				return nil
			}
			return p.terms.Type(t.ID, []byte(c.Input), RemoteCols, RemoteRows)
		},
		Status: func(t protocol.Thread) (bool, string) { return p.terms.Running(t.ID), "" },
		Stop:   func(t protocol.Thread) { p.terms.Kill(t.ID) },
		Delete: func(t protocol.Thread, _ plugin.DeleteParams) func() {
			return func() { p.terms.Kill(t.ID) }
		},
	})
	h.HandleChannel(protocol.TermChannelPrefix, func(ctx context.Context, c plugin.ChannelContext, dc *webrtc.DataChannel) {
		termchan.Serve(ctx, dc, c.Rest, p.terms)
	})
	return nil
}

func (p *Plugin) Stop() { p.terms.Shutdown() }

type service struct{ m *term.Manager }

func (s service) Type(id string, input []byte, cols, rows uint16) error {
	return s.m.Type(id, input, cols, rows)
}
func (s service) Scrollback(id string) []byte { return s.m.Scrollback(id) }

// shells resolves where a terminal starts for the terminal manager: a tab
// of a claude thread in a worktree starts in that worktree.
type shells struct{ h plugin.Host }

func (r shells) ThreadShell(threadID string) (string, bool, error) {
	dir, had, err := r.h.Store().ThreadShell(threadID)
	if err != nil {
		return "", false, err
	}
	// A missing worktree is left for claude to recreate; the shell falls
	// back to the project.
	if wd, err := r.h.Threads().Workdir(threadID); err == nil && wd.Worktree {
		if _, err := os.Stat(wd.Path); err == nil {
			dir = wd.Path
		}
	}
	return dir, had, nil
}

func (r shells) MarkSpawned(threadID string) error { return r.h.Store().MarkSpawned(threadID) }
func (r shells) TouchThread(threadID string) error { return r.h.Store().TouchThread(threadID) }
