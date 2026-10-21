// Package desktop is the remote desktop plugin: seeing and controlling the
// device's logged-in desktop over WebRTC sessions of its own, desktop tabs,
// and the desktop_* tools. It needs consent on the device (everywhere
// desktop enable) and is never reachable over the hub.
package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"runtime"
	"sync"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop"
	"github.com/conner-replogle/everywhere/daemon/internal/desktop/wire"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// Plugin is the remote desktop plugin.
type Plugin struct {
	m *desktop.Manager // nil if its media stack failed to build

	mu       sync.Mutex
	sessions map[string]string // rtc session id → desktop session id
}

// New makes the remote desktop plugin.
func New() *Plugin { return &Plugin{sessions: map[string]string{}} }

func (p *Plugin) Manifest() plugin.Manifest {
	m := plugin.Manifest{
		ID: "desktop", Title: "Remote desktop", API: plugin.API, Builtin: true,
		Permissions: []string{plugin.PermScreen, plugin.PermAgentTools},
	}
	if supported() {
		m.Features = []string{protocol.FeatureDesktop}
	}
	return m
}

func supported() bool { return runtime.GOOS == "linux" || runtime.GOOS == "windows" }

func (p *Plugin) Start(h plugin.Host) error {
	if d, err := desktop.NewManager(h.WebRTC().SettingEngine()); err != nil {
		slog.Error("remote desktop unavailable", "err", err)
	} else {
		d.ICEServers = h.WebRTC().ICEServers
		d.Enabled = h.Config().DesktopEnabled
		d.ArtifactsDir = filepath.Join(h.DataDir(), "desktop", "artifacts")
		p.m = d
	}
	h.Export(plugin.ServiceDesktop, service{p})
	// Never over the hub: none of these is Remote.
	h.HandleRPC("desktop.info", func(context.Context, plugin.RPCContext, json.RawMessage) (any, error) {
		if p.m == nil {
			return protocol.DesktopInfo{Reason: "remote desktop isn't available in this daemon"}, nil
		}
		return p.m.Info(), nil
	})
	if p.m == nil {
		return nil
	}

	h.AddKind(plugin.KindHandler{
		Kind: plugin.Kind{Kind: protocol.ThreadDesktop},
		Delete: func(t protocol.Thread, _ plugin.DeleteParams) func() {
			return func() { p.m.CloseTab(t.ID) }
		},
	})
	plugin.Subscribe(h.Bus(), plugin.ThreadDeleted, func(e plugin.ThreadEvent) {
		if e.Thread.ParentID == "" {
			p.m.CloseAgent(e.Thread.ID)
		}
	})
	plugin.Subscribe(h.Bus(), plugin.ClientRevoked, p.m.CloseClient)

	h.HandleSession("desktop", plugin.SessionHandler{
		Open: func(_ context.Context, s plugin.Session, offer string, raw json.RawMessage) (string, error) {
			var ps startParams
			if err := plugin.Unmarshal(raw, &ps); err != nil {
				return "", err
			}
			started, err := p.start(s.Peer(), offer, ps, func(_ string, c webrtc.ICECandidateInit) { s.SendCandidate(c) })
			if err != nil {
				return "", err
			}
			p.mu.Lock()
			p.sessions[s.ID()] = started.ID
			p.mu.Unlock()
			return started.SDP, nil
		},
		Candidate: func(s plugin.Session, c webrtc.ICECandidateInit) {
			if id := p.desktopID(s.ID()); id != "" {
				p.m.AddCandidate(id, c)
			}
		},
		Closed: func(s plugin.Session) {
			p.mu.Lock()
			id := p.sessions[s.ID()]
			delete(p.sessions, s.ID())
			p.mu.Unlock()
			if id != "" {
				p.m.Stop(id)
			}
		},
	})
	// What web apps from before rtc.* sessions use.
	h.HandleRPC("desktop.start", p.legacy("desktop.start"), plugin.Slow())
	h.HandleRPC("desktop.candidate", p.legacy("desktop.candidate"))
	h.HandleRPC("desktop.stop", p.legacy("desktop.stop"))

	if supported() {
		for _, t := range desktop.Tools(p.m) {
			h.AddTools(plugin.Tool{Tool: t})
		}
	}
	h.ContributeAgent(func(l plugin.AgentLaunch) plugin.AgentContribution {
		if !l.Scratch || !p.usable() {
			return plugin.AgentContribution{}
		}
		return plugin.AgentContribution{SystemPrompt: []string{"The mcp__everywhere__desktop_* tools let you see and use the computer's screen when that helps."}}
	})
	return nil
}

func (p *Plugin) Stop() {
	if p.m != nil {
		p.m.Shutdown()
	}
}

func (p *Plugin) desktopID(sessionID string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.sessions[sessionID]
}

func (p *Plugin) usable() bool {
	if p.m == nil {
		return false
	}
	d := p.m.Info()
	return d.Enabled && d.Available
}

type service struct{ p *Plugin }

func (s service) Usable() bool { return s.p.usable() }

type startParams struct {
	Mode   string                 `json:"mode"`
	Viewer string                 `json:"viewer"`
	Source protocol.DesktopSource `json:"source"`
	TabID  string                 `json:"tabId"`
}

// start starts a desktop session for the browser at peer. A session belongs
// to its hub connection, so signing that browser out ends it.
func (p *Plugin) start(peer plugin.Peer, offer string, ps startParams, onCandidate func(string, webrtc.ICECandidateInit)) (protocol.DesktopStarted, error) {
	mode, ok := wire.ParseMode(ps.Mode)
	if !ok {
		mode = wire.ModeSharp
	}
	name := ps.Viewer
	if name == "" {
		name = "A browser"
	}
	return p.m.Start(offer, mode, desktop.Viewer{Name: name, Client: peer.Client(), Tab: ps.TabID}, ps.Source, onCandidate)
}

// legacy serves desktop.start, desktop.candidate and desktop.stop, signaled
// over the calling browser's control channel.
func (p *Plugin) legacy(method string) plugin.RPCFunc {
	return func(_ context.Context, c plugin.RPCContext, raw json.RawMessage) (any, error) {
		return p.callLegacy(method, c, raw)
	}
}

func (p *Plugin) callLegacy(method string, c plugin.RPCContext, raw json.RawMessage) (any, error) {
	if c.Peer == nil {
		return nil, errors.New("remote desktop needs a browser connection")
	}
	var ps struct {
		startParams
		ID        string                 `json:"id"`
		SDP       string                 `json:"sdp"`
		Candidate *protocol.IceCandidate `json:"candidate"`
	}
	if err := json.Unmarshal(raw, &ps); err != nil {
		return nil, fmt.Errorf("bad params: %w", err)
	}
	switch method {
	case "desktop.start":
		peer := c.Peer
		return p.start(peer, ps.SDP, ps.startParams, func(id string, ci webrtc.ICECandidateInit) {
			peer.Send(protocol.DesktopCandidateEvent{
				Event: protocol.EventDesktopCandidate,
				ID:    id,
				Candidate: protocol.IceCandidate{
					Candidate: ci.Candidate, SDPMid: ci.SDPMid, SDPMLineIndex: ci.SDPMLineIndex, UsernameFragment: ci.UsernameFragment,
				},
			})
		})
	case "desktop.candidate":
		ci := ps.Candidate
		if ci == nil {
			return plugin.Empty{}, nil
		}
		p.m.AddCandidate(ps.ID, webrtc.ICECandidateInit{
			Candidate: ci.Candidate, SDPMid: ci.SDPMid, SDPMLineIndex: ci.SDPMLineIndex, UsernameFragment: ci.UsernameFragment,
		})
		return plugin.Empty{}, nil
	default:
		p.m.Stop(ps.ID)
		return plugin.Empty{}, nil
	}
}
