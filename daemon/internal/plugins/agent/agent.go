// Package agent is the agent plugin: coding agents' threads and tabs, all
// run by one engine (package agent) and drawn by the app's agent view:
// Claude Code's through package claude, others' (OpenCode, and those
// plugins add with AgentService.AddAgent) over the Agent Client Protocol
// through package harness. It also serves the
// upload: channel, signs claude in, and reads and drives agent threads over
// the hub. Other plugins reach agents through the AgentService it exports
// and add to claude's launch with ContributeAgent.
package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/agent"
	"github.com/conner-replogle/everywhere/daemon/internal/harness"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

const (
	remoteEventsDefault = 40
	remoteEventsMax     = 500
	remoteWaitMax       = 50 * time.Second
)

// Plugin is the agent plugin.
type Plugin struct {
	h      plugin.Host
	m      *agent.Manager
	mcpDir string
}

// New makes the agent plugin.
func New() *Plugin { return &Plugin{} }

func (p *Plugin) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID: "agent", Title: "Agents", API: plugin.API, Builtin: true,
		Permissions: []string{plugin.PermExec, plugin.PermFSWrite, plugin.PermAgentTools, plugin.PermRemote},
		Features: []string{protocol.FeatureClaude, protocol.FeatureWorktrees, protocol.FeatureAttachments, protocol.FeatureHistory,
			protocol.FeatureRewind, protocol.FeatureClaudeUpdate, protocol.FeatureClaudeAuth, protocol.FeatureToken},
	}
}

// Manager is the agent manager, for tests.
func (p *Plugin) Manager() *agent.Manager { return p.m }

func (p *Plugin) Start(h plugin.Host) error {
	p.h = h
	dataDir := h.DataDir()
	p.m = agent.NewManager(h.Store(), dataDir, h.Threads().Changed)
	p.m.AuthChanged = func() { h.Emit(protocol.RPCEvent{Event: protocol.EventClaudeAuth}) }
	p.m.Notify = h.Notify
	p.mcpDir = filepath.Join(dataDir, "mcp")
	clearMCPConfigs(p.mcpDir)
	p.m.ThreadArgs = p.claudeArgs
	h.Export(plugin.ServiceAgent, service{p})

	// Other agents: a thread kind each, for those installed here, run by
	// the same manager through their harness.
	p.m.ThreadMCP = p.harnessMCP
	for _, a := range harness.Available() {
		h.AddKind(p.agentKind(a))
	}

	h.AddKind(plugin.KindHandler{
		Kind: plugin.Kind{Kind: protocol.ThreadClaude, Thread: true},
		Created: func(t protocol.Thread, c plugin.CreateParams) error {
			if err := p.initialMode(t, c.PermissionMode); err != nil {
				return err
			}
			if strings.TrimSpace(c.Prompt) != "" {
				return p.m.Request(t.ID, protocol.AgentClientMsg{T: "send", Text: c.Prompt})
			}
			return nil
		},
		Status: func(t protocol.Thread) (bool, string) { return p.m.Status(t.ID) },
		Stop:   func(t protocol.Thread) { p.m.Kill(t.ID) },
		Delete: func(t protocol.Thread, d plugin.DeleteParams) func() {
			// Its record (the worktree) goes with the row; read it first.
			a, err := h.Store().AgentThread(t.ID)
			if err != nil {
				return func() { p.m.Kill(t.ID) }
			}
			return func() { p.m.Remove(t.ID, a, d.KeepWorktree) }
		},
	})
	plugin.Subscribe(h.Bus(), plugin.DaemonUpdating, func(struct{}) { p.m.MarkForContinuation() })

	h.HandleChannel(protocol.AgentChannelPrefix, func(ctx context.Context, c plugin.ChannelContext, dc *webrtc.DataChannel) {
		serveChannel(ctx, p.m, dc, c.Rest)
	})
	h.HandleChannel(protocol.UploadChannelPrefix, func(ctx context.Context, c plugin.ChannelContext, dc *webrtc.DataChannel) {
		serveUpload(ctx, p.m, dc, c.Rest)
	})

	type params struct {
		Force   bool   `json:"force"`
		Console bool   `json:"console"`
		Token   string `json:"token"`
		Code    string `json:"code"`
	}
	rpc := func(method string, fn func(ctx context.Context, p params) (any, error), opts ...plugin.RPCOption) {
		h.HandleRPC(method, func(ctx context.Context, _ plugin.RPCContext, raw json.RawMessage) (any, error) {
			var ps params
			if err := plugin.Unmarshal(raw, &ps); err != nil {
				return nil, err
			}
			return fn(ctx, ps)
		}, append(opts, plugin.Remote())...)
	}
	rpc("agent.info", func(context.Context, params) (any, error) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		return p.m.Info(ctx), nil
	}, plugin.Slow())
	rpc("agent.claudeVersion", func(_ context.Context, ps params) (any, error) {
		return p.m.ClaudeVersion(context.Background(), ps.Force)
	}, plugin.Slow())
	rpc("agent.updateClaude", func(context.Context, params) (any, error) {
		return p.m.UpdateClaude(context.Background())
	}, plugin.Slow())
	rpc("agent.auth", func(context.Context, params) (any, error) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		return p.m.ClaudeAuth(ctx)
	}, plugin.Slow())
	rpc("agent.login", func(_ context.Context, ps params) (any, error) {
		return p.m.StartLogin(context.Background(), ps.Console)
	}, plugin.Slow())
	rpc("agent.loginCode", func(_ context.Context, ps params) (any, error) {
		return p.m.FinishLogin(context.Background(), ps.Code)
	}, plugin.Slow())
	rpc("agent.loginCancel", func(context.Context, params) (any, error) {
		p.m.CancelLogin()
		return plugin.Empty{}, nil
	}, plugin.Slow())
	// The hub sends the account's Claude token with this.
	rpc("agent.setToken", func(_ context.Context, ps params) (any, error) {
		if err := p.m.SetToken(ps.Token); err != nil {
			return nil, err
		}
		h.Emit(protocol.RPCEvent{Event: protocol.EventClaudeAuth})
		return plugin.Empty{}, nil
	})

	h.HandleRPC("threads.search", plugin.Params(func(_ plugin.RPCContext, s struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}) (any, error) {
		return h.Store().SearchAgentEvents(s.Query, min(max(s.Limit, 1), 50))
	}), plugin.Remote())
	h.HandleRPC("agent.read", plugin.Params(p.remoteRead), plugin.RemoteOnly())
	h.HandleRPC("agent.request", plugin.Params(func(_ plugin.RPCContext, r struct {
		ThreadID string                  `json:"threadId"`
		Msg      protocol.AgentClientMsg `json:"msg"`
	}) (any, error) {
		if _, err := p.agentThread(r.ThreadID); err != nil {
			return nil, err
		}
		if err := p.m.Request(r.ThreadID, r.Msg); err != nil {
			return nil, err
		}
		return plugin.Empty{}, nil
	}), plugin.RemoteOnly())

	go p.m.ContinueMarked() // turns interrupted by an update
	return nil
}

func (p *Plugin) Stop() { p.m.Shutdown() }

// initialMode sets a new claude thread's permission mode, if one was asked for.
func (p *Plugin) initialMode(t protocol.Thread, mode string) error {
	if mode == "" {
		return nil
	}
	if !agent.ValidPermissionMode(mode) {
		return fmt.Errorf("unknown permission mode %q", mode)
	}
	return p.h.Store().SetAgentPermissionMode(t.ID, mode)
}

// agentThread is a thread of claude or another agent.
func (p *Plugin) agentThread(id string) (protocol.Thread, error) {
	t, err := p.h.Threads().Get(id)
	if err != nil {
		return t, err
	}
	if !agent.IsAgentKind(t.Kind) {
		return t, errors.New("not an agent thread")
	}
	return t, nil
}

// AgentRead is what agent.read returns: a claude thread, its live state and
// a page of its log, oldest first.
type AgentRead struct {
	Thread protocol.Thread             `json:"thread"`
	State  protocol.AgentState         `json:"state"`
	Events []protocol.AgentLoggedEvent `json:"events"`
	// More: there are older events before the first one here.
	More bool `json:"more"`
	// LastSeq is the newest event's seq, for afterSeq next time.
	LastSeq int64 `json:"lastSeq"`
}

type readParams struct {
	ThreadID  string `json:"threadId"`
	AfterSeq  int64  `json:"afterSeq"`
	BeforeSeq int64  `json:"beforeSeq"`
	Limit     int    `json:"limit"`
	WaitMs    int64  `json:"waitMs"`
}

// remoteRead reads a claude thread: the newest limit events after afterSeq
// (and before beforeSeq, if set). With waitMs, it first waits up to that
// long for a turn in progress to finish or block on a prompt.
func (p *Plugin) remoteRead(_ plugin.RPCContext, r readParams) (any, error) {
	t, err := p.agentThread(r.ThreadID)
	if err != nil {
		return nil, err
	}
	if wait := min(time.Duration(r.WaitMs)*time.Millisecond, remoteWaitMax); wait > 0 {
		deadline := time.Now().Add(wait)
		for time.Now().Before(deadline) {
			if _, status := p.m.Status(t.ID); status != "starting" && status != "working" {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	limit := r.Limit
	if limit <= 0 {
		limit = remoteEventsDefault
	}
	events, more, err := p.h.Store().AgentEvents(t.ID, r.AfterSeq, r.BeforeSeq, min(limit, remoteEventsMax))
	if err != nil {
		return nil, err
	}
	st, err := p.m.State(t.ID)
	if err != nil {
		return nil, err
	}
	// Every client gets these from device.info and agent.info instead.
	st.Models, st.Commands = nil, nil
	if live, err := p.h.Threads().Live(t.ID); err == nil {
		t = live
	}
	out := AgentRead{Thread: t, State: st, Events: make([]protocol.AgentLoggedEvent, len(events)), More: more}
	for i, e := range events {
		out.Events[i] = protocol.AgentLoggedEvent{Seq: e.Seq, At: e.At, Event: e.Event}
		out.LastSeq = e.Seq
	}
	return out, nil
}

// service is the AgentService other plugins use.
// agentKind is the kind of another agent's threads.
func (p *Plugin) agentKind(a harness.Agent) plugin.KindHandler {
	return plugin.KindHandler{
		Kind: plugin.Kind{Kind: a.Kind, Title: a.Title, Thread: true, View: "agent", Icon: a.Icon},
		Created: func(t protocol.Thread, c plugin.CreateParams) error {
			if strings.TrimSpace(c.Prompt) != "" {
				return p.m.Request(t.ID, protocol.AgentClientMsg{T: "send", Text: c.Prompt})
			}
			return nil
		},
		Status: func(t protocol.Thread) (bool, string) { return p.m.Status(t.ID) },
		Stop:   func(t protocol.Thread) { p.m.Kill(t.ID) },
		Delete: func(t protocol.Thread, d plugin.DeleteParams) func() {
			a, err := p.h.Store().AgentThread(t.ID)
			if err != nil {
				return func() { p.m.Kill(t.ID) }
			}
			return func() { p.m.Remove(t.ID, a, d.KeepWorktree) }
		},
	}
}

type service struct{ p *Plugin }

func (s service) AddAgent(h plugin.Host, d plugin.AgentDef) func() {
	a := harness.Agent{Kind: d.Kind, Title: d.Title, Icon: d.Icon, Command: d.Command}
	forget := harness.Add(a)
	h.AddKind(s.p.agentKind(a))
	// Its threads stop with it; their history stays for when it's back.
	return func() {
		s.p.m.KillKind(a.Kind)
		forget()
	}
}

func (s service) Notify(threadID, name, text, prompt string, wake bool) {
	s.p.m.ProcessEvent(threadID, name, text, prompt, wake)
}

func (s service) Send(threadID, text string) error {
	return s.p.m.Request(threadID, protocol.AgentClientMsg{T: "send", Text: text})
}

func (s service) MarkDone(threadID string) (bool, error) { return s.p.m.MarkDone(threadID) }

func (s service) ShareFiles(threadID, caption string, paths []string) ([]protocol.AgentAttachment, error) {
	return s.p.m.ShareFiles(threadID, caption, paths)
}

func (s service) Status(threadID string) (bool, string) { return s.p.m.Status(threadID) }

func (s service) Conversation(threadID string, limit int) ([]json.RawMessage, error) {
	events, _, err := s.p.h.Store().AgentEvents(threadID, 0, 0, limit)
	if err != nil {
		return nil, err
	}
	out := make([]json.RawMessage, len(events))
	for i, e := range events {
		out[i] = e.Event
	}
	return out, nil
}

var _ plugin.AgentService = service{}
