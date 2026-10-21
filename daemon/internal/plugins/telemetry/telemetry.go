// Package telemetry is the telemetry plugin: what processes report about
// themselves (metrics, events, files, progress), received on a loopback
// HTTP server and kept in their projects, and the telemetry.* queries
// charts and dashboards make of it.
package telemetry

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/processes"
	"github.com/conner-replogle/everywhere/daemon/internal/process"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/telemetry"
)

// Plugin is the telemetry plugin.
type Plugin struct {
	h     plugin.Host
	hub   *telemetry.Hub
	procs *process.Manager
}

// New makes the telemetry plugin.
func New() *Plugin { return &Plugin{} }

func (p *Plugin) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID: "telemetry", Title: "Telemetry", API: plugin.API, Builtin: true,
		Requires:    []string{"processes"},
		Permissions: []string{plugin.PermNetLoopback, plugin.PermFSWrite, plugin.PermRemote},
	}
}

func (p *Plugin) Start(h plugin.Host) error {
	p.h = h
	p.procs = plugin.MustLookup[*process.Manager](h, processes.Service)
	p.hub = telemetry.New()
	p.hub.OnProgress = p.procs.ReportFromProcess
	p.hub.OnChange = func(home string, changed map[string][]string) {
		h.Emit(protocol.TelemetryChanged{Event: protocol.EventTelemetryChanged, Home: home, Experiments: changed})
	}
	if err := p.hub.Start(); err != nil {
		// Processes still run; they just have nowhere to report.
		slog.Error("telemetry endpoint unavailable", "err", err)
	} else {
		p.procs.Telemetry = p.hub
	}
	for _, m := range []string{"telemetry.catalog", "telemetry.query", "telemetry.events", "telemetry.deleteRun"} {
		h.HandleRPC(m, func(_ context.Context, _ plugin.RPCContext, raw json.RawMessage) (any, error) {
			return p.call(m, raw)
		}, plugin.Remote())
	}
	return nil
}

func (p *Plugin) Stop() { p.hub.Close() }

// callTelemetry serves the telemetry.* methods: what charts and dashboards
// ask of a project's telemetry. The project is a process's (processId) or a
// thread's (threadId); never a path the caller gives.
func (p *Plugin) call(method string, raw json.RawMessage) (any, error) {
	var q struct {
		ProcessID  string          `json:"processId"`
		ThreadID   string          `json:"threadId"`
		Experiment string          `json:"experiment"`
		Run        string          `json:"run"`
		Runs       []string        `json:"runs"`
		Kind       string          `json:"kind"`
		Before     int64           `json:"before"`
		Limit      int             `json:"limit"`
		Query      telemetry.Query `json:"query"`
	}
	if err := plugin.Unmarshal(raw, &q); err != nil {
		return nil, err
	}
	home, err := p.home(q.ProcessID, q.ThreadID)
	if err != nil {
		return nil, err
	}
	switch method {
	case "telemetry.catalog":
		return p.hub.Catalog(home, q.Experiment)
	case "telemetry.query":
		return p.hub.Query(home, q.Query)
	case "telemetry.events":
		if q.Experiment == "" {
			return nil, fmt.Errorf("give an experiment")
		}
		return p.hub.Events(home, q.Experiment, q.Runs, q.Kind, q.Before, q.Limit)
	case "telemetry.deleteRun":
		return plugin.Empty{}, p.hub.DeleteRun(home, q.Experiment, q.Run)
	}
	return nil, fmt.Errorf("unknown method %q", method)
}

// home is the project a telemetry call is about.
func (p *Plugin) home(processID, threadID string) (string, error) {
	if processID != "" {
		v, err := p.procs.Get(processID)
		if err != nil {
			return "", err
		}
		if v.Home != "" {
			return v.Home, nil
		}
		threadID = v.ThreadID
	}
	if threadID == "" {
		return "", fmt.Errorf("give a processId or threadId")
	}
	w, err := p.h.Threads().Workdir(threadID)
	if err != nil {
		return "", err
	}
	return w.Path, nil
}
