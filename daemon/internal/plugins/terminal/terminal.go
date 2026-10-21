// Package terminal is the terminal plugin: terminal threads and tabs, the
// term: channel, and reading and typing into terminals over the hub.
package terminal

import (
	"context"
	"errors"
	"os"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/termchan"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/term"
)

const (
	remoteTermDefault = 16 << 10
	remoteTermMax     = 256 << 10
	// RemoteCols and RemoteRows are the size of a shell started by typing
	// into it (an agent, or a new tab's input); the browser's attach resizes it.
	RemoteCols, RemoteRows = 120, 32
)

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
		Permissions: []string{plugin.PermPTY, plugin.PermRemote},
	}
}

func (p *Plugin) Start(h plugin.Host) error {
	p.h = h
	p.terms = term.NewManager(shells{h}, h.Threads().Changed)
	h.Export(plugin.ServiceTerminal, service{p.terms})
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
	h.HandleRPC("term.read", plugin.Params(p.read), plugin.Remote())
	h.HandleRPC("term.write", plugin.Params(p.write), plugin.Remote())
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

// TermRead is what term.read returns: a terminal thread and the end of its
// scrollback as plain text.
type TermRead struct {
	Thread protocol.Thread `json:"thread"`
	Output string          `json:"output"`
	// Truncated: there was more scrollback than maxBytes.
	Truncated bool `json:"truncated"`
}

type readParams struct {
	ThreadID string `json:"threadId"`
	MaxBytes int    `json:"maxBytes"`
}

func (p *Plugin) terminal(id string) (protocol.Thread, error) {
	t, err := p.h.Threads().Get(id)
	if err != nil {
		return t, err
	}
	if t.Kind != protocol.ThreadTerminal {
		return t, errors.New("not a terminal thread")
	}
	return t, nil
}

func (p *Plugin) read(_ plugin.RPCContext, r readParams) (any, error) {
	t, err := p.terminal(r.ThreadID)
	if err != nil {
		return nil, err
	}
	if live, err := p.h.Threads().Live(t.ID); err == nil {
		t = live
	}
	limit := r.MaxBytes
	if limit <= 0 {
		limit = remoteTermDefault
	}
	text := PlainText(p.terms.Scrollback(t.ID))
	out := TermRead{Thread: t, Output: text}
	if over := len(text) - min(limit, remoteTermMax); over > 0 {
		cut := over
		for cut < len(text) && !utf8.RuneStart(text[cut]) {
			cut++
		}
		out.Output, out.Truncated = text[cut:], true
	}
	return out, nil
}

type writeParams struct {
	ThreadID string `json:"threadId"`
	Text     string `json:"text"`
}

// write types into a terminal; it bypasses the writer role.
func (p *Plugin) write(_ plugin.RPCContext, w writeParams) (any, error) {
	t, err := p.terminal(w.ThreadID)
	if err != nil {
		return nil, err
	}
	if t.ArchivedAt != nil {
		return nil, errors.New("this thread is archived; restore it first")
	}
	if err := p.terms.Type(w.ThreadID, []byte(w.Text), RemoteCols, RemoteRows); err != nil {
		return nil, err
	}
	return plugin.Empty{}, nil
}

// Escape sequences: CSI, OSC (ended by BEL or ST), and other two-byte ESC
// sequences, plus charset selection.
var ansiRe = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[@-_]`)

// PlainText turns terminal output into roughly what the screen shows as
// text: escape sequences dropped, and a carriage return overwriting its line.
func PlainText(b []byte) string {
	text := ansiRe.ReplaceAllString(strings.ToValidUTF8(string(b), "�"), "")
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	for i, l := range lines {
		if j := strings.LastIndexByte(strings.TrimRight(l, "\r"), '\r'); j >= 0 {
			l = l[j+1:]
		}
		// Apply backspaces.
		if strings.ContainsRune(l, '\b') {
			var out []rune
			for _, r := range l {
				if r == '\b' {
					if len(out) > 0 {
						out = out[:len(out)-1]
					}
					continue
				}
				out = append(out, r)
			}
			l = string(out)
		}
		lines[i] = strings.TrimRight(strings.Map(func(r rune) rune {
			if r < 0x20 && r != '\t' {
				return -1
			}
			return r
		}, l), " ")
	}
	return strings.Join(lines, "\n")
}
