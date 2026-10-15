package peer

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
)

// doneToolName is the tool a claude thread's agent marks its thread done with.
const doneToolName = "thread_done"

// doneTools lets a thread's agent say its work is finished, so the sidebar
// can put the thread away (as T3 Code's settle does).
func (s *Server) doneTools() []mcp.Tool {
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
			afterTurn, err := s.agents.MarkDone(c.ThreadID)
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
