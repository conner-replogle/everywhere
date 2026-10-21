// Package browser is the browser plugin: each thread's page in the
// daemon's Chromium, the browser tab and browser: channel that show it,
// and the browser_* tools claude drives it with.
package browser

import (
	"context"
	"path/filepath"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/browser"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// Plugin is the browser plugin.
type Plugin struct {
	m *browser.Manager
}

// New makes the browser plugin.
func New() *Plugin { return &Plugin{} }

func (p *Plugin) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID: "browser", Title: "Browser", API: plugin.API, Builtin: true,
		Permissions: []string{plugin.PermExec, plugin.PermBrowser, plugin.PermAgentTools},
	}
}

// Manager is the browser manager, for tests.
func (p *Plugin) Manager() *browser.Manager { return p.m }

func (p *Plugin) Start(h plugin.Host) error {
	p.m = browser.NewManager(filepath.Join(h.DataDir(), "browser"))
	p.m.ICEServers = h.WebRTC().ICEServers
	h.AddKind(plugin.KindHandler{
		Kind: plugin.Kind{Kind: protocol.ThreadBrowser, Single: true},
		Delete: func(t protocol.Thread, _ plugin.DeleteParams) func() {
			return func() { p.m.Close(t.ParentID, "The browser tab was closed", true) }
		},
	})
	plugin.Subscribe(h.Bus(), plugin.ThreadArchived, func(e plugin.ThreadEvent) {
		p.m.Close(e.Thread.ID, "The thread was archived", false)
	})
	plugin.Subscribe(h.Bus(), plugin.ThreadDeleted, func(e plugin.ThreadEvent) {
		if e.Thread.ParentID == "" {
			p.m.Close(e.Thread.ID, "The thread was deleted", true)
		}
	})
	h.HandleChannel(protocol.BrowserChannelPrefix, func(ctx context.Context, c plugin.ChannelContext, dc *webrtc.DataChannel) {
		// A tab's id means its thread's browser.
		key, err := h.Threads().Owner(c.Rest)
		if err != nil {
			// Web apps from before tabs ask for browser:<projectId>.
			if _, err := h.Store().GetProject(c.Rest); err != nil {
				_ = dc.Close()
				return
			}
			key = c.Rest
		}
		serveChannel(ctx, p.m, dc, key)
	})
	for _, t := range browser.Tools(p.m) {
		h.AddTools(plugin.Tool{Tool: t})
	}
	return nil
}

func (p *Plugin) Stop() { p.m.Shutdown() }
