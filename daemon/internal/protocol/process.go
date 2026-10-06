package protocol

// Process statuses.
const (
	ProcessRunning = "running"
	ProcessExited  = "exited"  // ended by itself; see ExitCode
	ProcessStopped = "stopped" // stopped by the user, the model or the daemon
	ProcessFailed  = "failed"  // didn't start
	ProcessLost    = "lost"    // the daemon went away while it ran
	ProcessDone    = "done"    // a tracker that was marked done
)

// Process is a command a thread runs in the background, or a tracker (no
// command) whose progress the model reports itself. See SPEC.md, Processes.
type Process struct {
	ID       string `json:"id"`
	ThreadID string `json:"threadId"`
	Name     string `json:"name"`
	Command  string `json:"command,omitempty"`
	Cwd      string `json:"cwd,omitempty"`
	Status   string `json:"status"`
	ExitCode *int   `json:"exitCode,omitempty"`
	// Notify: the model asked to be told when it ends.
	Notify    bool   `json:"notify,omitempty"`
	StartedAt int64  `json:"startedAt"`
	EndedAt   *int64 `json:"endedAt,omitempty"`

	Checkpoints []ProcessCheckpoint `json:"checkpoints"`
	Stats       []ProcessStat       `json:"stats"`
	// StatusText is the phase the process last reported.
	StatusText string `json:"statusText,omitempty"`
	// Progress is the terminal progress (OSC 9;4) it last reported.
	Progress *ProcessProgress `json:"progress,omitempty"`
	URLs     []string         `json:"urls,omitempty"`
	LastLine string           `json:"lastLine,omitempty"`
	// LogPath is the raw output on disk.
	LogPath string `json:"logPath,omitempty"`
}

// ProcessCheckpoint is a milestone, declared at start (optionally with a
// pattern matched against output lines) or reported by the process.
type ProcessCheckpoint struct {
	Label   string `json:"label"`
	Pattern string `json:"pattern,omitempty"`
	Notify  bool   `json:"notify,omitempty"`
	// ReachedAt is when it was reached, and Offset where in the log.
	ReachedAt *int64 `json:"reachedAt,omitempty"`
	Offset    int64  `json:"offset,omitempty"`
	// PrevMs is how long after starting the previous run reached it.
	PrevMs *int64 `json:"prevMs,omitempty"`
}

// ProcessStat is a number the process reports: a counter when it has a
// total.
type ProcessStat struct {
	Key   string   `json:"key"`
	Label string   `json:"label,omitempty"`
	Unit  string   `json:"unit,omitempty"`
	Value float64  `json:"value"`
	Total *float64 `json:"total,omitempty"`
	// Rate is per second, over the last few seconds; ETA is in seconds.
	Rate *float64 `json:"rate,omitempty"`
	ETA  *float64 `json:"eta,omitempty"`
	// History is one sample a second, oldest first.
	History    []float64 `json:"history,omitempty"`
	NotifyWhen string    `json:"notifyWhen,omitempty"`
}

// ProcessProgress is OSC 9;4's state: normal, error, indeterminate or
// paused, with a percentage for all but indeterminate.
type ProcessProgress struct {
	State   string `json:"state"`
	Percent int    `json:"percent"`
}
