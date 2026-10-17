package protocol

import "encoding/json"

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
	// Widgets are the charts and tables the model asked to show.
	Widgets []ProcessWidget `json:"widgets,omitempty"`
	// Dashboard names its dashboard, .everywhere/dashboards/<name> in the
	// thread's directory.
	Dashboard string `json:"dashboard,omitempty"`
	// Experiment and Run are what it reports as in its project's telemetry
	// (.everywhere/telemetry.db).
	Experiment string `json:"experiment,omitempty"`
	Run        string `json:"run,omitempty"`
	// DashboardState is its dashboard's own state (processes.setState), kept
	// in the project with its events.
	DashboardState map[string]json.RawMessage `json:"dashboardState,omitempty"`
	// Home is the directory its project's .everywhere is in.
	Home string `json:"home,omitempty"`
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

// Widget kinds.
const (
	WidgetLine  = "line"  // series of points over time, or over x_label
	WidgetBar   = "bar"   // a value per category
	WidgetGauge = "gauge" // one value between min and max
	WidgetTable = "table" // rows keyed by their first cell
)

// ProcessWidget is a chart or table on a process, declared by the model or
// the process and fed by ::ew lines, process_report or its stats.
type ProcessWidget struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Title string `json:"title,omitempty"`
	Unit  string `json:"unit,omitempty"`
	// Stats are the stats it shows: a line's series over time, a bar's
	// categories; Stat is a gauge's value.
	Stats []string `json:"stats,omitempty"`
	Stat  string   `json:"stat,omitempty"`

	// Line: without XLabel, x is seconds since the process started.
	XLabel string          `json:"xLabel,omitempty"`
	Series []ProcessSeries `json:"series,omitempty"`
	// Bar.
	Bars []ProcessBar `json:"bars,omitempty"`
	// Gauge: Warn and Critical are thresholds; below Warn is fine unless
	// Critical is lower than Warn, when low values are the bad ones.
	Value    *float64 `json:"value,omitempty"`
	Min      *float64 `json:"min,omitempty"`
	Max      *float64 `json:"max,omitempty"`
	Warn     *float64 `json:"warn,omitempty"`
	Critical *float64 `json:"critical,omitempty"`
	// Table.
	Columns []string `json:"columns,omitempty"`
	Rows    [][]any  `json:"rows,omitempty"`
}

// ProcessSeries is one line of a line widget: [x, y] points, oldest first.
type ProcessSeries struct {
	Key    string       `json:"key"`
	Label  string       `json:"label,omitempty"`
	Points [][2]float64 `json:"points"`
}

type ProcessBar struct {
	Label string  `json:"label"`
	Value float64 `json:"value"`
}

// DashboardBuild answers processes.dashboard: the process's dashboard as
// one script (and stylesheet), or why it didn't build. Unchanged means the
// caller already has this version.
type DashboardBuild struct {
	Version   string   `json:"version"`
	Unchanged bool     `json:"unchanged,omitempty"`
	JS        string   `json:"js,omitempty"`
	CSS       string   `json:"css,omitempty"`
	Errors    []string `json:"errors,omitempty"`
}

// DashboardFile answers processes.file: a file a dashboard may read, to
// fetch over a file channel.
type DashboardFile struct {
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"`
	Type    string `json:"type"`
}
