// Package dashboards is the dashboards plugin: React pages a model writes
// for a process, bundled on the device and shown in a sandboxed frame, with
// the processes.* methods they read the process through and the
// dashboard_* tools.
package dashboards

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strings"

	"github.com/conner-replogle/everywhere/daemon/internal/dashboard"
	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/processes"
	"github.com/conner-replogle/everywhere/daemon/internal/process"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// Plugin is the dashboards plugin.
type Plugin struct {
	h      plugin.Host
	procs  *process.Manager
	builds *dashboard.Builder
}

// New makes the dashboards plugin.
func New() *Plugin { return &Plugin{} }

func (p *Plugin) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID: "dashboards", Title: "Dashboards", API: plugin.API, Builtin: true,
		Requires:    []string{"processes"},
		Optional:    []string{"telemetry"},
		Permissions: []string{plugin.PermFSRead, plugin.PermFSWrite, plugin.PermAgentTools, plugin.PermRemote},
	}
}

func (p *Plugin) Start(h plugin.Host) error {
	p.h = h
	p.procs = plugin.MustLookup[*process.Manager](h, processes.Service)
	p.builds = dashboard.NewBuilder()
	for _, m := range []string{"processes.dashboard", "processes.output", "processes.file", "processes.dashboardError", "processes.setState"} {
		h.HandleRPC(m, func(_ context.Context, _ plugin.RPCContext, raw json.RawMessage) (any, error) {
			return p.call(m, raw)
		}, plugin.Remote())
	}
	for _, t := range p.tools() {
		h.AddTools(plugin.Tool{Tool: t})
	}
	return nil
}

func (p *Plugin) Stop() {}

// maxDashboardFile caps a file a dashboard reads: the viewer holds it whole.
const maxDashboardFile = 50 << 20

const (
	dashboardBuildTool = "dashboard_build"
	dashboardDocsTool  = "dashboard_docs"
)

// callDashboards serves the processes.* methods a process's dashboard uses.
func (p *Plugin) call(method string, raw json.RawMessage) (any, error) {
	var q struct {
		ID      string          `json:"id"`
		Version string          `json:"version"`
		Tail    int             `json:"tail"`
		Grep    string          `json:"grep"`
		Path    string          `json:"path"`
		Message string          `json:"message"`
		Key     string          `json:"key"`
		Value   json.RawMessage `json:"value"`
	}
	if err := plugin.Unmarshal(raw, &q); err != nil {
		return nil, err
	}
	v, err := p.procs.Get(q.ID)
	if err != nil {
		return nil, err
	}
	switch method {
	case "processes.dashboard":
		if v.Dashboard == "" {
			return nil, errors.New("this process has no dashboard")
		}
		dir, err := p.processDashboardDir(v)
		if err != nil {
			return nil, err
		}
		r := p.builds.Build(dir)
		if q.Version == r.Version {
			return protocol.DashboardBuild{Version: r.Version, Unchanged: true}, nil
		}
		// A new build: errors the old one hit don't apply.
		p.procs.DashboardErrors(v.ID, true)
		return protocol.DashboardBuild{Version: r.Version, JS: r.JS, CSS: r.CSS, Errors: r.Errors}, nil
	case "processes.output":
		if v.Command == "" {
			return []string{}, nil
		}
		tail := q.Tail
		if tail <= 0 {
			tail = 200
		}
		lines, _, err := p.procs.Output(v.ID, "", q.Grep, min(tail, 2000), 256<<10)
		if lines == nil {
			lines = []string{}
		}
		return lines, err
	case "processes.file":
		return p.dashboardFile(v, q.Path)
	case "processes.dashboardError":
		p.procs.DashboardError(v.ID, q.Message)
		return plugin.Empty{}, nil
	case "processes.setState":
		return plugin.Empty{}, p.procs.SetDashboardState(v.ID, q.Key, q.Value)
	}
	return nil, fmt.Errorf("unknown method %q", method)
}

// processDashboardDir is a process's dashboard, in the project it ran in.
func (p *Plugin) processDashboardDir(v protocol.Process) (string, error) {
	if v.Home != "" {
		return dashboard.Dir(v.Home, v.Dashboard)
	}
	return p.dashboardDir(v.ThreadID, v.Dashboard)
}

func (p *Plugin) dashboardDir(threadID, name string) (string, error) {
	w, err := p.h.Threads().Workdir(threadID)
	if err != nil {
		return "", err
	}
	return dashboard.Dir(w.Path, name)
}

// dashboardFile finds a file a dashboard asked for: relative to the
// process's directory, and inside its thread's.
func (p *Plugin) dashboardFile(v protocol.Process, path string) (protocol.DashboardFile, error) {
	var out protocol.DashboardFile
	home := v.Home
	if home == "" {
		w, err := p.h.Threads().Workdir(v.ThreadID)
		if err != nil {
			return out, err
		}
		home = w.Path
	}
	// Relative to the process's directory; failing that the project's (where
	// attachments are, under .everywhere/files).
	base := v.Cwd
	if base == "" {
		base = home
	}
	full := plugin.ResolvePath(base, path)
	if _, err := os.Stat(full); err != nil && !filepath.IsAbs(path) {
		full = plugin.ResolvePath(home, path)
	}
	root, err := filepath.EvalSymlinks(home)
	if err != nil {
		return out, err
	}
	real, err := filepath.EvalSymlinks(full)
	if err != nil {
		return out, fmt.Errorf("%s: no such file", path)
	}
	if rel, err := filepath.Rel(root, real); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return out, fmt.Errorf("%s is outside the thread's directory", path)
	}
	info, err := os.Stat(real)
	if err != nil {
		return out, err
	}
	if info.IsDir() {
		return out, fmt.Errorf("%s is a directory", path)
	}
	if info.Size() > maxDashboardFile {
		return out, fmt.Errorf("%s is %d MB; a dashboard can read up to %d MB", path, info.Size()>>20, maxDashboardFile>>20)
	}
	typ := mime.TypeByExtension(filepath.Ext(real))
	if typ == "" {
		typ = "application/octet-stream"
	}
	return protocol.DashboardFile{Path: real, Size: info.Size(), ModTime: info.ModTime().UnixMilli(), Type: typ}, nil
}

// dashboardTools let an agent build the dashboards it writes and read how.
func (p *Plugin) tools() []mcp.Tool {
	return []mcp.Tool{
		{
			Name:  dashboardBuildTool,
			Title: "Build a dashboard",
			Description: "Build the dashboard in .everywhere/dashboards/<name> (index.tsx) and report errors with file:line, plus errors it hit while the user had it open. " +
				"Run it after writing or changing a dashboard. It also writes .everywhere/types/everywhere.d.ts, the component and hook API. " +
				"A dashboard is shown with the process whose process_start named it (dashboard: <name>), live. Read dashboard_docs before writing one.",
			InputSchema: json.RawMessage(`{"type": "object", "required": ["name"], "properties": {
    "name": {"type": "string", "description": "The dashboard's directory name under .everywhere/dashboards."}
  }}`),
			Annotations: mcp.Annotations{ReadOnly: true, Idempotent: true},
			Call: func(_ context.Context, c mcp.Caller, args json.RawMessage) (*mcp.Result, error) {
				if c.Browser == "" {
					return nil, errors.New("this session has no thread")
				}
				var a struct {
					Name string `json:"name"`
				}
				if err := json.Unmarshal(args, &a); err != nil {
					return nil, fmt.Errorf("invalid arguments: %w", err)
				}
				dir, err := p.dashboardDir(c.Browser, a.Name)
				if err != nil {
					return nil, err
				}
				r := p.builds.Build(dir)
				return mcp.Text(p.buildReport(c.Browser, a.Name, r)), nil
			},
		},
		{
			Name:        dashboardDocsTool,
			Title:       "Dashboard docs",
			Description: "How to write a dashboard for a process: the files, the components (charts, tables, gauges, images, video), the hooks that get the process's data, theming, and an example. Read it before writing one.",
			InputSchema: json.RawMessage(`{"type": "object", "properties": {}}`),
			Annotations: mcp.Annotations{ReadOnly: true, Idempotent: true},
			Call: func(context.Context, mcp.Caller, json.RawMessage) (*mcp.Result, error) {
				return mcp.Text(dashboard.Docs + "\n\n--- .everywhere/types/everywhere.d.ts ---\n" + dashboard.Types), nil
			},
		},
	}
}

// buildReport says how a build went, for the model.
func (p *Plugin) buildReport(threadID, name string, r dashboard.Result) string {
	var b strings.Builder
	if len(r.Errors) > 0 {
		fmt.Fprintf(&b, "%s failed to build:\n%s", name, strings.Join(r.Errors, "\n"))
	} else {
		fmt.Fprintf(&b, "Built %s (%d KB).", name, (len(r.JS)+len(r.CSS)+1023)>>10)
	}
	if len(r.Warnings) > 0 {
		fmt.Fprintf(&b, "\nWarnings:\n%s", strings.Join(r.Warnings, "\n"))
	}
	list, _ := p.procs.List(threadID)
	var shown []string
	for _, v := range list {
		if v.Dashboard != name {
			continue
		}
		shown = append(shown, fmt.Sprintf("%s (%s)", v.Name, v.Status))
		if errs := p.procs.DashboardErrors(v.ID, false); len(errs) > 0 {
			fmt.Fprintf(&b, "\nWhile the user viewed it with %s, it hit:\n%s", v.Name, strings.Join(errs, "\n"))
		}
	}
	if len(shown) > 0 {
		fmt.Fprintf(&b, "\nShown with: %s. Open viewers reload it by themselves.", strings.Join(shown, ", "))
	} else {
		fmt.Fprintf(&b, "\nNo process shows it yet: start one with dashboard: %q (or set it with process_report).", name)
	}
	return b.String()
}
