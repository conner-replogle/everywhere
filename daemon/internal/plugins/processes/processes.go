// Package processes is the processes plugin: long-running commands a model
// (or the user) starts for a thread, their proc: channels, the processes
// tab and the process_* tools. Telemetry and dashboards build on it.
package processes

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/termchan"
	"github.com/conner-replogle/everywhere/daemon/internal/process"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// Service is the name the process manager is exported under, for the
// built-in plugins that extend processes (telemetry, dashboards).
const Service = "processes"

// Plugin is the processes plugin.
type Plugin struct {
	h plugin.Host
	m *process.Manager
}

// New makes the processes plugin.
func New() *Plugin { return &Plugin{} }

func (p *Plugin) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID: "processes", Title: "Processes", API: plugin.API, Builtin: true,
		Optional:    []string{"agent"},
		Permissions: []string{plugin.PermExec, plugin.PermPTY, plugin.PermAgentTools, plugin.PermAgentNotify, plugin.PermRemote},
		Features:    []string{protocol.FeatureProcesses},
	}
}

func (p *Plugin) Start(h plugin.Host) error {
	p.h = h
	p.m = process.NewManager(h.Store(), filepath.Join(h.DataDir(), "processes"))
	p.m.Workdir = func(id string) (string, error) {
		w, err := h.Threads().Workdir(id)
		return w.Path, err
	}
	p.m.OnRunning = h.Threads().Changed
	p.m.OnChange = func(threadID string) {
		h.Emit(protocol.ProcessesChanged{Event: protocol.EventProcessesChanged, ThreadID: threadID})
	}
	p.m.Notify = p.notice
	h.Export(Service, p.m)

	h.AddKind(plugin.KindHandler{Kind: plugin.Kind{Kind: protocol.ThreadProcesses, Single: true}})
	h.DecorateThread(func(t *protocol.Thread) {
		if t.ParentID == "" {
			t.Processes = p.m.Running(t.ID)
		}
	})
	// Archiving a thread stops its processes; deleting removes them.
	plugin.Subscribe(h.Bus(), plugin.ThreadArchived, func(e plugin.ThreadEvent) { p.m.StopThread(e.Thread.ID) })
	plugin.Subscribe(h.Bus(), plugin.ThreadDeleting, func(e plugin.ThreadEvent) {
		if e.Thread.ParentID == "" {
			p.m.RemoveThread(e.Thread.ID)
		}
	})

	h.HandleChannel(protocol.ProcChannelPrefix, func(ctx context.Context, c plugin.ChannelContext, dc *webrtc.DataChannel) {
		termchan.Serve(ctx, dc, c.Rest, p.m)
	})
	for _, t := range process.Tools(p.m) {
		h.AddTools(plugin.Tool{Tool: t, Ask: t.Name == "process_start"})
	}

	type params struct {
		ID       string `json:"id"`
		ThreadID string `json:"threadId"`
		Name     string `json:"name"`
		Command  string `json:"command"`
		Cwd      string `json:"cwd"`
	}
	rpc := func(method string, fn func(params) (any, error)) {
		h.HandleRPC(method, plugin.Params(func(_ plugin.RPCContext, ps params) (any, error) { return fn(ps) }), plugin.Remote())
	}
	// A tab's processes are its thread's.
	rpc("processes.list", func(ps params) (any, error) {
		owner, err := h.Threads().Owner(ps.ThreadID)
		if err != nil {
			return nil, err
		}
		return p.m.List(owner)
	})
	rpc("processes.start", func(ps params) (any, error) {
		owner, err := h.Threads().Owner(ps.ThreadID)
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(ps.Command) == "" {
			return nil, errors.New("give a command")
		}
		v, err := p.m.Start(owner, "", ps.Name, process.Spec{Command: strings.TrimSpace(ps.Command), Cwd: ps.Cwd}, false)
		if err != nil && v.ID == "" {
			return nil, err
		}
		return v, nil // a process that failed to start is still listed
	})
	rpc("processes.stop", func(ps params) (any, error) { return plugin.Empty{}, p.m.Stop(ps.ID, true) })
	rpc("processes.restart", func(ps params) (any, error) { return p.m.Restart(ps.ID) })
	rpc("processes.remove", func(ps params) (any, error) { return plugin.Empty{}, p.m.Remove(ps.ID) })
	return nil
}

func (p *Plugin) Stop() { p.m.Shutdown() }

// notice passes a process event to the claude thread or tab that started
// the process, or else to its thread if that's a claude thread.
func (p *Plugin) notice(threadID, agentThreadID string, n process.Notice) {
	agent, ok := plugin.Lookup[plugin.AgentService](p.h, plugin.ServiceAgent)
	if !ok {
		return
	}
	for _, id := range []string{agentThreadID, threadID} {
		if id == "" {
			continue
		}
		t, err := p.h.Threads().Get(id)
		if err != nil || t.Kind != protocol.ThreadClaude || t.ArchivedAt != nil {
			continue
		}
		agent.Notify(id, n.Name, n.Text, n.Prompt, n.Wake)
		return
	}
	slog.Debug("process event with no claude thread to tell", "thread", threadID, "process", n.Name)
}
