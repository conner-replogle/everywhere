package peer

import (
	"encoding/json"
	"fmt"

	"github.com/conner-replogle/everywhere/daemon/internal/telemetry"
)

// callTelemetry serves the telemetry.* methods: what charts and dashboards
// ask of a project's telemetry. The project is a process's (processId) or a
// thread's (threadId); never a path the caller gives.
func (s *Server) callTelemetry(method string, raw json.RawMessage) (any, error) {
	var p struct {
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
	if err := unmarshal(raw, &p); err != nil {
		return nil, err
	}
	home, err := s.telemetryHome(p.ProcessID, p.ThreadID)
	if err != nil {
		return nil, err
	}
	switch method {
	case "telemetry.catalog":
		return s.telemetry.Catalog(home, p.Experiment)
	case "telemetry.query":
		return s.telemetry.Query(home, p.Query)
	case "telemetry.events":
		if p.Experiment == "" {
			return nil, fmt.Errorf("give an experiment")
		}
		return s.telemetry.Events(home, p.Experiment, p.Runs, p.Kind, p.Before, p.Limit)
	case "telemetry.deleteRun":
		return empty{}, s.telemetry.DeleteRun(home, p.Experiment, p.Run)
	}
	return nil, fmt.Errorf("unknown method %q", method)
}

// telemetryHome is the project a telemetry call is about.
func (s *Server) telemetryHome(processID, threadID string) (string, error) {
	if processID != "" {
		v, err := s.procs.Get(processID)
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
	w, err := s.workdir(threadID)
	if err != nil {
		return "", err
	}
	return w.Path, nil
}
