// Package done is the done plugin: marking a thread done (put away in the
// sidebar until it's touched again), by the user or by its claude's
// thread_done tool.
package done

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// Plugin is the done plugin.
type Plugin struct {
	h plugin.Host
}

// New makes the done plugin.
func New() *Plugin { return &Plugin{} }

func (p *Plugin) Manifest() plugin.Manifest {
	return plugin.Manifest{
		ID: "done", Title: "Done threads", API: plugin.API, Builtin: true,
		Optional:    []string{"agent"},
		Permissions: []string{plugin.PermAgentTools, plugin.PermRemote},
		Features:    []string{protocol.FeatureDone},
	}
}

func (p *Plugin) Start(h plugin.Host) error {
	p.h = h
	h.HandleRPC("threads.done", plugin.Params(func(_ plugin.RPCContext, r struct {
		ID   string `json:"id"`
		Done bool   `json:"done"`
	}) (any, error) {
		if err := h.Store().SetThreadDone(r.ID, r.Done); err != nil {
			return nil, err
		}
		h.Threads().Changed()
		return h.Threads().Live(r.ID)
	}), plugin.Remote())
	if _, ok := h.Service(plugin.ServiceAgent); ok {
		for _, t := range p.tools() {
			h.AddTools(plugin.Tool{Tool: t})
		}
	}
	return nil
}

func (p *Plugin) Stop() {}

// doneToolName is the tool a claude thread's agent marks its thread done with.
const doneToolName = "thread_done"

// doneTools lets a thread's agent say its work is finished, so the sidebar
// can put the thread away (as T3 Code's settle does).
func (s *Plugin) tools() []mcp.Tool {
	return []mcp.Tool{{
		Name:  doneToolName,
		Title: "Mark this thread done",
		Description: "Mark this thread done: the task the user gave you is finished, and nothing in it is waiting on you or on them. " +
			"The user's sidebar then moves the thread out of their active list, under Done, until they write in it again. " +
			"It takes effect when your turn ends, and only if the turn completes: a turn that fails or is stopped, or a new message from the user during it, leaves the thread open. " +
			"Call it as the last thing you do when you have finished the work and told the user so. " +
			"Don't call it when you are asking a question, waiting for a decision, handing the user steps to do, or waiting on a process you started (a dev server left running for the user is fine).",
		InputSchema: json.RawMessage(`{"type": "object", "properties": {}}`),
		Annotations: mcp.Annotations{Idempotent: true},
		Call: func(_ context.Context, c mcp.Caller, _ json.RawMessage) (*mcp.Result, error) {
			if c.ThreadID == "" {
				return nil, errors.New("this session has no thread to mark done")
			}
			afterTurn, err := plugin.MustLookup[plugin.AgentService](s.h, plugin.ServiceAgent).MarkDone(c.ThreadID)
			if err != nil {
				return nil, err
			}
			if afterTurn {
				return mcp.Text("The thread will be marked done when this turn completes. Finish your reply; don't do more work in this turn."), nil
			}
			return mcp.Text("The thread is marked done."), nil
		},
	}}
}
