// Package goal is the goal plugin: the tools a thread's agent works with
// in goal mode (see internal/agent/goal.go), goal_get and goal_update, and
// thread_wake, which wakes it later (internal/agent/wake.go). The user
// sets, pauses, resumes and clears a goal through the agent channel (the
// goal request, or /goal typed as a prompt). Threads' summaries carry their
// goal's status, for the sidebar.
package goal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/processes"
	"github.com/conner-replogle/everywhere/daemon/internal/process"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// Plugin is the goal plugin.
type Plugin struct {
	h plugin.Host
}

// New makes the goal plugin.
func New() *Plugin { return &Plugin{} }

func (p *Plugin) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID: "goal", Title: "Goal mode and wakes", API: plugin.API, Builtin: true,
		Requires:    []string{"agent"},
		Optional:    []string{"processes"},
		Permissions: []string{plugin.PermAgentTools},
		Features:    []string{protocol.FeatureGoal},
	}
}

func (p *Plugin) Start(h plugin.Host) error {
	p.h = h
	h.DecorateThread(func(t *protocol.Thread) { t.Goal = p.agent().GoalStatus(t.ID) })
	for _, t := range p.tools() {
		h.AddTools(plugin.Tool{Tool: t})
	}
	return nil
}

func (p *Plugin) Stop() {}

func (p *Plugin) agent() plugin.AgentService {
	return plugin.MustLookup[plugin.AgentService](p.h, plugin.ServiceAgent)
}

func (p *Plugin) tools() []mcp.Tool {
	return []mcp.Tool{{
		Name:  "goal_get",
		Title: "Get this thread's goal",
		Description: "Get this thread's goal, if the user set one (goal mode): its objective, its status " +
			"(active, waiting, paused, blocked, limited or complete) and how many of its turns are used.",
		InputSchema: json.RawMessage(`{"type": "object", "properties": {}}`),
		Annotations: mcp.Annotations{ReadOnly: true},
		Call: func(_ context.Context, c mcp.Caller, _ json.RawMessage) (*mcp.Result, error) {
			if c.ThreadID == "" {
				return nil, errors.New("this session has no thread")
			}
			g, err := p.agent().Goal(c.ThreadID)
			if err != nil {
				return nil, err
			}
			if g == nil {
				return mcp.Text("This thread has no goal."), nil
			}
			return mcp.JSON(g)
		},
	}, {
		Name:  "goal_update",
		Title: "Report on this thread's goal",
		Description: "Report where this thread's goal stands, in goal mode (the user set an objective, and each time your turn ends Everywhere starts the next). " +
			"complete: every part of the objective is done and you checked each against what you can see now; give a one-line summary as reason. The thread is then marked done. " +
			"blocked: you can't go on without the user (a decision only they can make, access, credentials) after trying what you can; reason says what you need. " +
			"waiting: you're waiting on a process you started with process_start and notify: true; you're woken when it ends or reaches a checkpoint, so end your turn after this. " +
			"Don't call it just to keep going: ending your turn does that.",
		InputSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "status": {"type": "string", "enum": ["complete", "blocked", "waiting"]},
    "reason": {"type": "string", "description": "complete: a one-line summary. blocked: what you need from the user. waiting: what you wait on."}
  },
  "required": ["status", "reason"]
}`),
		Call: func(_ context.Context, c mcp.Caller, raw json.RawMessage) (*mcp.Result, error) {
			if c.ThreadID == "" {
				return nil, errors.New("this session has no thread")
			}
			var in struct {
				Status string `json:"status"`
				Reason string `json:"reason"`
			}
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, err
			}
			running, err := p.processesRunning(c.ThreadID)
			if err != nil {
				return nil, err
			}
			reply, err := p.agent().UpdateGoal(c.ThreadID, in.Status, in.Reason, running)
			if err != nil {
				return nil, err
			}
			return mcp.Text(reply), nil
		},
	}, {
		Name:  "thread_wake",
		Title: "Wake me later",
		Description: "Have Everywhere wake you in this thread after a while: a new turn starts then with your reason " +
			"(or it joins your turn, if one is running). Use it to check back on something with no process to wait on " +
			"(a deploy, a CI run, a reply), or to work on a schedule. One wake per thread: a new one replaces it; minutes 0 cancels it. " +
			"For a process you started, use process_start with notify: true instead; it wakes you when the process ends.",
		InputSchema: json.RawMessage(`{
  "type": "object",
  "properties": {
    "minutes": {"type": "number", "minimum": 0, "maximum": 10080, "description": "How long from now, at least 1 (0 cancels the wake)."},
    "reason": {"type": "string", "description": "What to do when you wake, in a line; you'll be shown it."}
  },
  "required": ["minutes"]
}`),
		Call: func(_ context.Context, c mcp.Caller, raw json.RawMessage) (*mcp.Result, error) {
			if c.ThreadID == "" {
				return nil, errors.New("this session has no thread")
			}
			var in struct {
				Minutes float64 `json:"minutes"`
				Reason  string  `json:"reason"`
			}
			if err := json.Unmarshal(raw, &in); err != nil {
				return nil, err
			}
			d := time.Duration(in.Minutes * float64(time.Minute)).Round(time.Second)
			at, err := p.agent().ScheduleWake(c.ThreadID, d, in.Reason)
			if err != nil {
				return nil, err
			}
			if d == 0 {
				return mcp.Text("The wake is canceled."), nil
			}
			return mcp.Text(fmt.Sprintf("You'll be woken at %s (in %s). End your turn when you've nothing else to do.",
				at.Format(time.RFC3339), d)), nil
		},
	}}
}

// processesRunning reports whether any of the thread's processes runs, to
// wait on.
func (p *Plugin) processesRunning(threadID string) (bool, error) {
	procs, ok := plugin.Lookup[*process.Manager](p.h, processes.Service)
	if !ok {
		return false, nil
	}
	owner, err := p.h.Threads().Owner(threadID)
	if err != nil {
		return false, err
	}
	return procs.Running(owner) > 0, nil
}
