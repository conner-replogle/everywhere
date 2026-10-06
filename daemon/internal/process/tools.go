package process

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

const (
	startWait      = 5 * time.Second
	startWaitFor   = 2 * time.Minute
	maxToolWait    = 10 * time.Minute
	defaultTail    = 100
	maxTail        = 2000
	maxOutputBytes = 64 << 10
	statusLines    = 20
	startLines     = 40
)

// ToolNames lists the tools that are safe to allow without asking: all but
// process_start, which runs a command.
func ToolNames() []string {
	var names []string
	for _, d := range toolDefs {
		if d.name != "process_start" {
			names = append(names, d.name)
		}
	}
	return names
}

// Tools returns the MCP tools for the caller's thread's processes.
func Tools(m *Manager) []mcp.Tool {
	tools := make([]mcp.Tool, 0, len(toolDefs))
	for _, d := range toolDefs {
		run := d.run
		tools = append(tools, mcp.Tool{
			Name: d.name, Title: d.title, Description: d.description,
			InputSchema: json.RawMessage(d.schema),
			Annotations: d.annotations,
			Call: func(ctx context.Context, c mcp.Caller, args json.RawMessage) (*mcp.Result, error) {
				// The thread owns processes, whichever of its tabs started them.
				if c.Browser == "" {
					return nil, errors.New("this session has no thread to run processes for")
				}
				return run(ctx, m, c, args)
			},
		})
	}
	return tools
}

type toolDef struct {
	name, title, description string
	schema                   string
	annotations              mcp.Annotations
	run                      func(ctx context.Context, m *Manager, c mcp.Caller, args json.RawMessage) (*mcp.Result, error)
}

var (
	readOnly = mcp.Annotations{ReadOnly: true, Idempotent: true}
	changes  = mcp.Annotations{}
	stops    = mcp.Annotations{Destructive: true, Idempotent: true}
	runs     = mcp.Annotations{Destructive: true, OpenWorld: true}
)

const nameProp = `"name": {"type": "string", "description": "The process's name, as given to process_start."}`

const reportHelp = `

The process can report progress by printing lines that start with "::ew " (hidden from the user's log view; flush stdout, e.g. print(..., flush=True)):
  ::ew stat KEY VALUE[/TOTAL] [UNIT] ["Label"]   e.g. ::ew stat migrated 120/4000 "Users migrated"  (a total makes a progress bar)
  ::ew stat KEY +1                             increment
  ::ew checkpoint "Label"                      reach a declared checkpoint, or add one
  ::ew status "Backfilling orders"             current phase
  ::ew notify "text"                           tell you about something now (starts a turn if you're idle)
  ::ew {"stat":"migrated","value":120,"total":4000}
When you write a script that will run for a while, have it report this way so the user can see how far along it is.`

var toolDefs = []toolDef{
	{
		name: "process_start", title: "Start process", annotations: runs,
		description: "Start a long-running command in the background for this thread: a dev server, watcher, build, test run, migration or script. The user sees it, with live progress and its log, in the everywhere app's processes tab, and it keeps running across your turns. Use this instead of a backgrounded shell command (never append & or use nohup). " +
			"It runs in the user's login shell in the thread's directory (or cwd) on a terminal. Returns its status, progress and recent output once wait_for happens, the process exits, or timeout_s passes (default 5s, enough to catch a crash on startup). " +
			"Declare checkpoints (milestones, optionally matched by a regex on output lines, e.g. {label:'Ready', pattern:'Local:.*http'}) and stats (counters with a total get a progress bar; notify_when like '> 0' tells you when it becomes true). " +
			"When it exits you're told: right away if notify is set (even if that starts a turn), otherwise with your next message. Leave out command to make a tracker: a progress bar you update with process_report while you work through a long task yourself." + reportHelp,
		schema: `{"type": "object", "required": ["name"], "properties": {
    "name": {"type": "string", "description": "Short name, unique in this thread, e.g. dev, tests, migrate. Starting a name again starts a new run of it."},
    "command": {"type": "string", "description": "Shell command line. Leave out for a tracker."},
    "cwd": {"type": "string", "description": "Directory, relative to the thread's directory or absolute."},
    "env": {"type": "object", "additionalProperties": {"type": "string"}, "description": "Extra environment variables."},
    "checkpoints": {"type": "array", "items": {"type": "object", "required": ["label"], "properties": {
      "label": {"type": "string"},
      "pattern": {"type": "string", "description": "Regex (Go syntax) matched against each plain-text output line; the first match reaches the checkpoint. Without one, the process reports it with ::ew checkpoint."},
      "notify": {"type": "boolean", "description": "Tell you when it's reached."}}}},
    "stats": {"type": "array", "items": {"type": "object", "required": ["key"], "properties": {
      "key": {"type": "string", "description": "Letters, digits, - and _."},
      "label": {"type": "string"},
      "total": {"type": "number", "description": "Makes it a counter with a progress bar, rate and ETA."},
      "unit": {"type": "string"},
      "notify_when": {"type": "string", "description": "Tell you when this becomes true, e.g. '> 0' or '>= 100'."}}}},
    "notify": {"type": "boolean", "description": "Tell you as soon as it exits, starting a turn if you're idle. Use it for builds and test runs you're waiting on."},
    "wait_for": {"type": "string", "description": "A checkpoint label to wait for (e.g. the server's Ready), or 'exit' to wait for it to finish."},
    "timeout_s": {"type": "number", "minimum": 0, "maximum": 600, "description": "Longest to wait, in seconds. Default 5, or 120 with wait_for."},
    "replace": {"type": "boolean", "description": "If a process with this name is running, stop it first."}
  }}`,
		run: func(ctx context.Context, m *Manager, c mcp.Caller, args json.RawMessage) (*mcp.Result, error) {
			var a struct {
				Name        string            `json:"name"`
				Command     string            `json:"command"`
				Cwd         string            `json:"cwd"`
				Env         map[string]string `json:"env"`
				Checkpoints []CheckpointSpec  `json:"checkpoints"`
				Stats       []StatSpec        `json:"stats"`
				Notify      bool              `json:"notify"`
				WaitFor     string            `json:"wait_for"`
				TimeoutS    *float64          `json:"timeout_s"`
				Replace     bool              `json:"replace"`
			}
			if err := decode(args, &a); err != nil {
				return nil, err
			}
			spec := Spec{Command: strings.TrimSpace(a.Command), Cwd: a.Cwd, Env: a.Env, Checkpoints: a.Checkpoints, Stats: a.Stats, Notify: a.Notify}
			v, err := m.Start(c.Browser, c.ThreadID, a.Name, spec, a.Replace)
			if err != nil {
				return nil, err
			}
			if spec.Command == "" {
				return mcp.Text("Tracker started. Update it with process_report as you go, and pass done when finished.\n\n" + summary(v, nil, false)), nil
			}
			wait := startWait
			if a.WaitFor != "" {
				wait = startWaitFor
			}
			if a.TimeoutS != nil {
				wait = time.Duration(max(0, *a.TimeoutS) * float64(time.Second))
			}
			wait = min(wait, maxToolWait)
			until := a.WaitFor
			if until == "" {
				until = "exit"
			}
			v, reached, err := m.Wait(ctx, v.ID, until, wait)
			if err != nil {
				return nil, err
			}
			var head string
			switch {
			case v.Status != protocol.ProcessRunning:
				head = "It has already ended.\n\n"
			case a.WaitFor != "" && reached:
				head = fmt.Sprintf("Reached %q; still running.\n\n", a.WaitFor)
			case a.WaitFor != "":
				head = fmt.Sprintf("Still running; %q not reached after %s.\n\n", a.WaitFor, shortDuration(wait))
			default:
				head = "Running in the background.\n\n"
			}
			return outputResult(m, v, head, startLines)
		},
	},
	{
		name: "process_list", title: "List processes", annotations: readOnly,
		description: "List this thread's processes and trackers (running and recently finished) with their status and progress.",
		schema:      `{"type": "object", "properties": {}}`,
		run: func(_ context.Context, m *Manager, c mcp.Caller, _ json.RawMessage) (*mcp.Result, error) {
			list, err := m.List(c.Browser)
			if err != nil {
				return nil, err
			}
			if len(list) == 0 {
				return mcp.Text("No processes."), nil
			}
			parts := make([]string, 0, len(list))
			for _, v := range list {
				parts = append(parts, summary(v, nil, false))
			}
			return mcp.Text(strings.Join(parts, "\n\n")), nil
		},
	},
	{
		name: "process_status", title: "Process status", annotations: readOnly,
		description: "A process's status, checkpoints, stats (with rate and ETA), status text, URLs and last lines of output. Cheaper than reading its log when you only need to know how it's doing.",
		schema:      `{"type": "object", "required": ["name"], "properties": {` + nameProp + `}}`,
		run: func(_ context.Context, m *Manager, c mcp.Caller, args json.RawMessage) (*mcp.Result, error) {
			var a struct {
				Name string `json:"name"`
			}
			if err := decode(args, &a); err != nil {
				return nil, err
			}
			v, err := m.Find(c.Browser, a.Name)
			if err != nil {
				return nil, err
			}
			return outputResult(m, v, "", statusLines)
		},
	},
	{
		name: "process_output", title: "Process output", annotations: readOnly,
		description: "Read a process's output as plain text (colors stripped, progress redraws collapsed): optionally only since a checkpoint, only lines matching grep, and only the last tail lines. At most 64 KB, keeping the end. For more, Read or Grep the log file it names.",
		schema: `{"type": "object", "required": ["name"], "properties": {` + nameProp + `,
    "tail": {"type": "integer", "minimum": 1, "maximum": 2000, "description": "Last N lines. Default 100."},
    "grep": {"type": "string", "description": "Only lines matching this regex (Go syntax)."},
    "since_checkpoint": {"type": "string", "description": "Only output after this checkpoint was reached."}
  }}`,
		run: func(_ context.Context, m *Manager, c mcp.Caller, args json.RawMessage) (*mcp.Result, error) {
			var a struct {
				Name            string `json:"name"`
				Tail            int    `json:"tail"`
				Grep            string `json:"grep"`
				SinceCheckpoint string `json:"since_checkpoint"`
			}
			if err := decode(args, &a); err != nil {
				return nil, err
			}
			v, err := m.Find(c.Browser, a.Name)
			if err != nil {
				return nil, err
			}
			if v.Command == "" {
				return nil, errors.New("a tracker has no output")
			}
			tail := a.Tail
			if tail <= 0 {
				tail = defaultTail
			}
			lines, cut, err := m.Output(v.ID, a.SinceCheckpoint, a.Grep, min(tail, maxTail), maxOutputBytes)
			if err != nil {
				return nil, err
			}
			head := fmt.Sprintf("%s · %s · log %s\n", v.Name, statusWord(v), v.LogPath)
			if cut {
				head += "(earlier lines left out)\n"
			}
			if len(lines) == 0 {
				return mcp.Text(head + "(no output)"), nil
			}
			return mcp.Text(head + strings.Join(lines, "\n")), nil
		},
	},
	{
		name: "process_wait", title: "Wait for process", annotations: readOnly,
		description: "Wait until a process reaches a checkpoint or exits, instead of sleeping. Returns early if it ends.",
		schema: `{"type": "object", "required": ["name", "until"], "properties": {` + nameProp + `,
    "until": {"type": "string", "description": "A checkpoint label, or 'exit'."},
    "timeout_s": {"type": "number", "minimum": 1, "maximum": 600, "description": "Longest to wait, in seconds. Default 120."}
  }}`,
		run: func(ctx context.Context, m *Manager, c mcp.Caller, args json.RawMessage) (*mcp.Result, error) {
			var a struct {
				Name     string  `json:"name"`
				Until    string  `json:"until"`
				TimeoutS float64 `json:"timeout_s"`
			}
			if err := decode(args, &a); err != nil {
				return nil, err
			}
			v, err := m.Find(c.Browser, a.Name)
			if err != nil {
				return nil, err
			}
			wait := startWaitFor
			if a.TimeoutS > 0 {
				wait = min(time.Duration(a.TimeoutS*float64(time.Second)), maxToolWait)
			}
			v, reached, err := m.Wait(ctx, v.ID, a.Until, wait)
			if err != nil {
				return nil, err
			}
			head := fmt.Sprintf("Reached %q.\n\n", a.Until)
			if !reached {
				if v.Status != protocol.ProcessRunning {
					head = fmt.Sprintf("It ended without reaching %q.\n\n", a.Until)
				} else {
					head = fmt.Sprintf("Not reached after %s; still running.\n\n", shortDuration(wait))
				}
			}
			return outputResult(m, v, head, statusLines)
		},
	},
	{
		name: "process_stop", title: "Stop process", annotations: stops,
		description: "Stop a running process (Ctrl-C, then terminate, then kill, to everything it started) or close a tracker.",
		schema:      `{"type": "object", "required": ["name"], "properties": {` + nameProp + `}}`,
		run: func(_ context.Context, m *Manager, c mcp.Caller, args json.RawMessage) (*mcp.Result, error) {
			var a struct {
				Name string `json:"name"`
			}
			if err := decode(args, &a); err != nil {
				return nil, err
			}
			v, err := m.Find(c.Browser, a.Name)
			if err != nil {
				return nil, err
			}
			if v.Status != protocol.ProcessRunning {
				return mcp.Text(fmt.Sprintf("%s isn't running (%s).", v.Name, statusWord(v))), nil
			}
			if err := m.Stop(v.ID, false); err != nil {
				return nil, err
			}
			v, _ = m.Get(v.ID)
			return mcp.Text(summary(v, nil, false)), nil
		},
	},
	{
		name: "process_report", title: "Report progress", annotations: changes,
		description: "Update a tracker's (or a running process's) progress yourself: set or increment a stat, reach a checkpoint, set the status text, or mark a tracker done. Use it to show the user how far along a long multi-step task is.",
		schema: `{"type": "object", "required": ["name"], "properties": {` + nameProp + `,
    "stat": {"type": "string", "description": "Stat key to update."},
    "value": {"type": "number", "description": "The stat's new value."},
    "inc": {"type": "number", "description": "Add this to the stat instead."},
    "total": {"type": "number"},
    "unit": {"type": "string"},
    "label": {"type": "string", "description": "The stat's label."},
    "checkpoint": {"type": "string", "description": "Reach this checkpoint (added if it wasn't declared)."},
    "status": {"type": "string", "description": "Status text, e.g. the step you're on."},
    "done": {"type": "boolean", "description": "Finish the tracker."}
  }}`,
		run: func(_ context.Context, m *Manager, c mcp.Caller, args json.RawMessage) (*mcp.Result, error) {
			var a struct {
				Name string `json:"name"`
				report
				Done bool `json:"done"`
			}
			if err := decode(args, &a); err != nil {
				return nil, err
			}
			v, err := m.Report(c.Browser, a.Name, a.report, a.Done)
			if err != nil {
				return nil, err
			}
			return mcp.Text(summary(v, nil, false)), nil
		},
	},
}

func outputResult(m *Manager, v protocol.Process, head string, n int) (*mcp.Result, error) {
	var lines []string
	if v.Command != "" {
		var err error
		if lines, _, err = m.Output(v.ID, "", "", n, 16<<10); err != nil {
			return nil, err
		}
	}
	return mcp.Text(head + summary(v, lines, true)), nil
}

func statusWord(v protocol.Process) string {
	switch {
	case v.Status == protocol.ProcessExited && v.ExitCode != nil:
		return fmt.Sprintf("exited %d", *v.ExitCode)
	case v.Status == protocol.ProcessRunning && v.Command == "":
		return "tracking"
	default:
		return v.Status
	}
}

// summary describes a process for the model.
func summary(v protocol.Process, lines []string, full bool) string {
	var b strings.Builder
	end := time.Now()
	if v.EndedAt != nil {
		end = time.UnixMilli(*v.EndedAt)
	}
	fmt.Fprintf(&b, "%s · %s · %s", v.Name, statusWord(v), shortDuration(end.Sub(time.UnixMilli(v.StartedAt))))
	if v.Command != "" {
		fmt.Fprintf(&b, "\ncommand: %s", clip(v.Command, 300))
		if full {
			fmt.Fprintf(&b, "\ncwd: %s", v.Cwd)
		}
	}
	if len(v.Checkpoints) > 0 {
		parts := make([]string, 0, len(v.Checkpoints))
		for _, c := range v.Checkpoints {
			switch {
			case c.ReachedAt != nil:
				parts = append(parts, fmt.Sprintf("✓ %s (%s)", c.Label, shortDuration(time.Duration(*c.ReachedAt-v.StartedAt)*time.Millisecond)))
			case c.PrevMs != nil:
				parts = append(parts, fmt.Sprintf("○ %s (last run %s)", c.Label, shortDuration(time.Duration(*c.PrevMs)*time.Millisecond)))
			default:
				parts = append(parts, "○ "+c.Label)
			}
		}
		fmt.Fprintf(&b, "\ncheckpoints: %s", strings.Join(parts, " · "))
	}
	if len(v.Stats) > 0 {
		parts := make([]string, 0, len(v.Stats))
		for _, s := range v.Stats {
			parts = append(parts, statText(s))
		}
		fmt.Fprintf(&b, "\nstats: %s", strings.Join(parts, " · "))
	}
	if v.StatusText != "" {
		fmt.Fprintf(&b, "\nstatus: %s", v.StatusText)
	}
	if v.Progress != nil {
		if v.Progress.State == "indeterminate" {
			b.WriteString("\nprogress: indeterminate")
		} else {
			fmt.Fprintf(&b, "\nprogress: %d%% (%s)", v.Progress.Percent, v.Progress.State)
		}
	}
	if len(v.URLs) > 0 {
		fmt.Fprintf(&b, "\nurls: %s", strings.Join(v.URLs, " "))
	}
	if full && v.LogPath != "" {
		fmt.Fprintf(&b, "\nlog: %s", v.LogPath)
	}
	if !full && v.LastLine != "" {
		fmt.Fprintf(&b, "\nlast line: %s", v.LastLine)
	}
	if len(lines) > 0 {
		fmt.Fprintf(&b, "\n--- last %d lines ---\n%s", len(lines), strings.Join(lines, "\n"))
	}
	return b.String()
}

func statText(s protocol.ProcessStat) string {
	name := s.Key
	if s.Label != "" {
		name = s.Label
	}
	val := formatNum(s.Value)
	if s.Total != nil {
		val += "/" + formatNum(*s.Total)
	}
	if s.Unit != "" {
		val += " " + s.Unit
	}
	var extra []string
	if s.Total != nil && *s.Total > 0 {
		extra = append(extra, fmt.Sprintf("%.0f%%", 100*s.Value / *s.Total))
	}
	if s.Rate != nil && *s.Rate != 0 {
		extra = append(extra, fmt.Sprintf("%.3g/s", *s.Rate))
	}
	if s.ETA != nil {
		extra = append(extra, "~"+shortDuration(time.Duration(*s.ETA*float64(time.Second)))+" left")
	}
	out := name + " " + val
	if len(extra) > 0 {
		out += " (" + strings.Join(extra, ", ") + ")"
	}
	return out
}

func decode(args json.RawMessage, out any) error {
	if len(args) == 0 {
		return nil
	}
	if err := json.Unmarshal(args, out); err != nil {
		return fmt.Errorf("invalid arguments: %w", err)
	}
	return nil
}
