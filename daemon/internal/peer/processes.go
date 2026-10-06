package peer

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/conner-replogle/everywhere/daemon/internal/process"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// callProcesses serves the processes.* control methods. A tab's processes
// are its thread's.
func (s *Server) callProcesses(method string, raw json.RawMessage) (any, error) {
	var p struct {
		ID       string `json:"id"`
		ThreadID string `json:"threadId"`
		Name     string `json:"name"`
		Command  string `json:"command"`
		Cwd      string `json:"cwd"`
	}
	if err := unmarshal(raw, &p); err != nil {
		return nil, err
	}
	switch method {
	case "processes.list":
		owner, err := s.browserKey(p.ThreadID)
		if err != nil {
			return nil, err
		}
		return s.procs.List(owner)
	case "processes.start":
		owner, err := s.browserKey(p.ThreadID)
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(p.Command) == "" {
			return nil, errors.New("give a command")
		}
		v, err := s.procs.Start(owner, "", p.Name, process.Spec{Command: strings.TrimSpace(p.Command), Cwd: p.Cwd}, false)
		if err != nil && v.ID == "" {
			return nil, err
		}
		return v, nil // a process that failed to start is still listed
	case "processes.stop":
		return empty{}, s.procs.Stop(p.ID, true)
	case "processes.restart":
		return s.procs.Restart(p.ID)
	case "processes.remove":
		return empty{}, s.procs.Remove(p.ID)
	}
	return nil, fmt.Errorf("unknown method %q", method)
}

// processNotice passes a process event to the claude thread or tab that
// started the process, or else to its thread if that's a claude thread.
func (s *Server) processNotice(threadID, agentThreadID string, n process.Notice) {
	for _, id := range []string{agentThreadID, threadID} {
		if id == "" {
			continue
		}
		t, err := s.store.GetThread(id)
		if err != nil || t.Kind != protocol.ThreadClaude || t.ArchivedAt != nil {
			continue
		}
		s.agents.ProcessEvent(id, n.Name, n.Text, n.Prompt, n.Wake)
		return
	}
	slog.Debug("process event with no claude thread to tell", "thread", threadID, "process", n.Name)
}
