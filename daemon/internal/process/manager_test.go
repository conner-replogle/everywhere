//go:build !windows

package process

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
	"github.com/conner-replogle/everywhere/daemon/internal/telemetry"
)

type note struct {
	agent, text string
	wake        bool
}

type fixture struct {
	hub    *telemetry.Hub
	home   string
	m      *Manager
	st     *store.Store
	thread string
	mu     sync.Mutex
	notes  []note
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	projects, _ := st.ListProjects()
	th, err := st.CreateThread(projects[0].ID, "t", protocol.ThreadClaude)
	if err != nil {
		t.Fatal(err)
	}
	fx := &fixture{st: st, thread: th.ID}
	fx.m = NewManager(st, filepath.Join(dir, "processes"))
	fx.m.Workdir = func(string) (string, error) { return dir, nil }
	fx.m.Notify = func(threadID, agent string, n Notice) {
		fx.mu.Lock()
		fx.notes = append(fx.notes, note{agent, n.Prompt, n.Wake})
		fx.mu.Unlock()
	}
	fx.hub = telemetry.New()
	fx.hub.OnProgress = fx.m.ReportFromProcess
	if err := fx.hub.Start(); err != nil {
		t.Fatal(err)
	}
	fx.m.Telemetry = fx.hub
	fx.home = dir
	t.Cleanup(fx.hub.Close)
	t.Cleanup(fx.m.Shutdown)
	return fx
}

func (fx *fixture) notesNow() []note {
	fx.mu.Lock()
	defer fx.mu.Unlock()
	return append([]note(nil), fx.notes...)
}

func TestProcessReportsAndExit(t *testing.T) {
	fx := newFixture(t)
	script := reportFn + `echo starting; ew '{"status":"Migrating"}'; ew '{"stat":"rows","value":2,"total":4,"label":"Rows"}'; ` +
		`echo 'compiled ok'; ew '{"checkpoint":"Half"}'; ew '{"notify":"careful"}'; echo 'see http://localhost:5173/'; exit 3`
	v, err := fx.m.Start(fx.thread, "agent1", "mig", Spec{
		Command:     script,
		Checkpoints: []CheckpointSpec{{Label: "Compiled", Pattern: "compiled ok"}, {Label: "Half"}},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	// Polled rather than waited for: a Wait would report the exit itself, so
	// the model wouldn't be told.
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if v, _ = fx.m.Get(v.ID); v.Status != protocol.ProcessRunning {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("didn't exit")
		}
	}
	if v.Status != protocol.ProcessExited || v.ExitCode == nil || *v.ExitCode != 3 {
		t.Fatalf("status %s code %v", v.Status, v.ExitCode)
	}
	if v.StatusText != "Migrating" {
		t.Errorf("status text %q", v.StatusText)
	}
	if len(v.Stats) != 1 || v.Stats[0].Value != 2 || *v.Stats[0].Total != 4 || v.Stats[0].Label != "Rows" {
		t.Errorf("stats %+v", v.Stats)
	}
	for _, c := range v.Checkpoints {
		if c.ReachedAt == nil {
			t.Errorf("checkpoint %q not reached", c.Label)
		}
	}
	if len(v.URLs) != 1 || v.URLs[0] != "http://localhost:5173/" {
		t.Errorf("urls %v", v.URLs)
	}

	// Saved, and the list reads it back from the row.
	list, _ := fx.m.List(fx.thread)
	if len(list) != 1 || list[0].Status != protocol.ProcessExited || list[0].StatusText != "Migrating" {
		t.Fatalf("list %+v", list)
	}

	// A notify the process sent wakes the model; the exit nobody asked about doesn't.
	var sawNotify, sawExit bool
	for _, n := range fx.notesNow() {
		if n.agent != "agent1" {
			t.Errorf("note went to %q", n.agent)
		}
		switch {
		case strings.Contains(n.text, "careful"):
			sawNotify = n.wake
		case strings.Contains(n.text, `status="exited" code="3"`):
			sawExit = true
			if n.wake {
				t.Error("exit woke the model without notify")
			}
			if !strings.Contains(n.text, "see http://localhost:5173/") {
				t.Errorf("exit note lacks the last lines: %s", n.text)
			}
		}
	}
	if !sawNotify || !sawExit {
		t.Fatalf("notes %+v", fx.notesNow())
	}

	// Reports never touch the log.
	lines, _, err := fx.m.Output(v.ID, "", "", 0, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(lines, "\n"); strings.Contains(got, "rows") || !strings.Contains(got, "compiled ok") {
		t.Errorf("log %q", lines)
	}
	since, _, _ := fx.m.Output(v.ID, "Half", "", 0, 1<<20)
	if len(since) == 0 || strings.Contains(strings.Join(since, "\n"), "starting") {
		t.Errorf("since checkpoint: %q", since)
	}
	grep, _, _ := fx.m.Output(v.ID, "", "localhost", 0, 1<<20)
	if len(grep) != 1 {
		t.Errorf("grep: %q", grep)
	}
	c := &client{}
	if err := fx.m.Attach(v.ID, c, 80, 24); err != nil {
		t.Fatal(err)
	}
	if out := c.String(); !strings.Contains(out, "compiled ok") || c.exited != 3 {
		t.Errorf("replay %q exited %d", out, c.exited)
	}

	// Starting it again reuses the row and remembers the timings.
	v2, err := fx.m.Start(fx.thread, "agent1", "mig", Spec{Command: "sleep 30", Checkpoints: []CheckpointSpec{{Label: "Half"}}}, false)
	if err != nil {
		t.Fatal(err)
	}
	if v2.ID != v.ID || v2.Checkpoints[0].PrevMs == nil {
		t.Fatalf("new run: %+v", v2)
	}
	if _, err := fx.m.Start(fx.thread, "agent1", "mig", Spec{Command: "true"}, false); err == nil {
		t.Fatal("started a running name twice")
	}
	if fx.m.Running(fx.thread) != 1 {
		t.Fatal("running count")
	}
	start := time.Now()
	if err := fx.m.Stop(v2.ID, true); err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 4*time.Second {
		t.Error("sleep didn't stop on SIGINT")
	}
	v2, _ = fx.m.Get(v2.ID)
	if v2.Status != protocol.ProcessStopped {
		t.Fatalf("after stop: %s", v2.Status)
	}
}

func TestWaitForCheckpoint(t *testing.T) {
	fx := newFixture(t)
	v, err := fx.m.Start(fx.thread, "", "srv", Spec{
		Command: "sleep 0.3; echo 'Listening on http://localhost:9999'; sleep 0.5; echo warmed; sleep 30",
		Checkpoints: []CheckpointSpec{
			{Label: "Ready", Pattern: "Listening", Notify: true},
			{Label: "Warm", Pattern: "warmed", Notify: true},
		},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	v, reached, err := fx.m.Wait(context.Background(), v.ID, "Ready", 10*time.Second)
	if err != nil || !reached || v.Status != protocol.ProcessRunning {
		t.Fatalf("reached %v status %s err %v", reached, v.Status, err)
	}
	// Nobody waits for Warm, so the model hears of it; Ready it waited for.
	deadline := time.Now().Add(5 * time.Second)
	for {
		var ready, warm bool
		for _, n := range fx.notesNow() {
			ready = ready || strings.Contains(n.text, `checkpoint="Ready"`)
			warm = warm || (strings.Contains(n.text, `checkpoint="Warm"`) && n.wake)
		}
		if ready {
			t.Fatal("told the model about a checkpoint it was waiting for")
		}
		if warm {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no wake for Warm: %+v", fx.notesNow())
		}
		time.Sleep(20 * time.Millisecond)
	}

	// A process that ends while waited for isn't announced either.
	w, _ := fx.m.Start(fx.thread, "", "quick", Spec{Command: "exit 2", Notify: true}, false)
	if _, reached, _ := fx.m.Wait(context.Background(), w.ID, "exit", 10*time.Second); !reached {
		t.Fatal("quick didn't exit")
	}
	time.Sleep(50 * time.Millisecond)
	for _, n := range fx.notesNow() {
		if strings.Contains(n.text, `name="quick"`) {
			t.Fatalf("told the model about an exit it waited for: %s", n.text)
		}
	}
}

func TestTracker(t *testing.T) {
	fx := newFixture(t)
	v, err := fx.m.Start(fx.thread, "", "refactor", Spec{Stats: []StatSpec{{Key: "files", Total: f(30)}}}, false)
	if err != nil {
		t.Fatal(err)
	}
	if v.Status != protocol.ProcessRunning || v.LogPath != "" {
		t.Fatalf("tracker %+v", v)
	}
	if fx.m.Running(fx.thread) != 0 {
		t.Error("trackers aren't running processes")
	}
	if _, err := fx.m.Report(fx.thread, "refactor", report{Stat: "files", Value: f(12)}, false); err != nil {
		t.Fatal(err)
	}
	// A new manager (a daemon restart) keeps the tracker open.
	m2 := NewManager(fx.st, t.TempDir())
	m2.Workdir = fx.m.Workdir
	v, err = m2.Report(fx.thread, "refactor", report{Checkpoint: "Half"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if v.Stats[0].Value != 12 || len(v.Checkpoints) != 1 {
		t.Fatalf("restored tracker %+v", v)
	}
	if v, err = m2.Report(fx.thread, "refactor", report{}, true); err != nil || v.Status != protocol.ProcessDone {
		t.Fatalf("done: %+v %v", v, err)
	}
}

func TestTrackerWidgets(t *testing.T) {
	fx := newFixture(t)
	spec := Spec{Widgets: []WidgetSpec{{ID: "fails", Kind: "bar", Title: "Failures"}}}
	if _, err := fx.m.Start(fx.thread, "", "triage", spec, false); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.m.Report(fx.thread, "triage", report{Bar: "fails", Label: "auth", Inc: f(3)}, false); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.m.Report(fx.thread, "triage", report{Plot: "fails", Series: "s", Y: f(1)}, false); err == nil {
		t.Fatal("plotted on a bar widget")
	}
	if _, err := fx.m.Report(fx.thread, "triage", report{Widget: &WidgetSpec{ID: "left", Kind: "gauge", Max: f(9)}, Gauge: "left", Value: f(4)}, false); err != nil {
		t.Fatal(err)
	}
	// Restored after a daemon restart, data and all.
	m2 := NewManager(fx.st, t.TempDir())
	m2.Workdir = fx.m.Workdir
	v, err := m2.Report(fx.thread, "triage", report{Bar: "fails", Label: "auth", Inc: f(1)}, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Widgets) != 2 || v.Widgets[0].Bars[0].Value != 4 || *v.Widgets[1].Value != 4 || v.Widgets[0].Title != "Failures" {
		t.Fatalf("restored widgets %+v", v.Widgets)
	}
	m2.Telemetry = fx.hub
	if _, err := m2.Report(fx.thread, "triage", report{Metrics: map[string]float64{"found": 1}, Dashboard: "triage"}, false); err != nil {
		t.Fatal(err)
	}
	v, _ = m2.Report(fx.thread, "triage", report{}, true)
	cat, err := fx.hub.Catalog(fx.home, "triage")
	if err != nil || len(cat.Metrics) != 1 || cat.Metrics[0].Name != "found" || v.Dashboard != "triage" || cat.Runs[0].Status != "done" {
		t.Fatalf("telemetry after done: %+v %v, dashboard %q", cat, err, v.Dashboard)
	}
}

type client struct {
	mu     sync.Mutex
	out    strings.Builder
	exited int
}

func (c *client) Output(p []byte) { c.mu.Lock(); c.out.Write(p); c.mu.Unlock() }
func (c *client) Writer(bool)     {}
func (c *client) Exited(code int) { c.mu.Lock(); c.exited = code; c.mu.Unlock() }
func (c *client) String() string  { c.mu.Lock(); defer c.mu.Unlock(); return c.out.String() }

// reportFn is a shell function the test scripts report with: ew '<json>'.
const reportFn = `ew() { curl -sf -H "X-Everywhere-Token: $EVERYWHERE_TOKEN" -d "$1" "$EVERYWHERE_TELEMETRY/progress" >/dev/null; }; ` +
	`ewlog() { curl -sf -H "X-Everywhere-Token: $EVERYWHERE_TOKEN" -d "$1" "$EVERYWHERE_TELEMETRY/log" >/dev/null; }; `

func TestTelemetryRuns(t *testing.T) {
	fx := newFixture(t)
	run := func() protocol.Process {
		t.Helper()
		v, err := fx.m.Start(fx.thread, "", "train", Spec{
			Command:   reportFn + `ewlog '{"step":1,"metrics":{"loss":2}}'; ewlog '{"step":2,"metrics":{"loss":1}}'; ew '{"stat":"epochs","value":1}'`,
			Dashboard: "train",
		}, false)
		if err != nil {
			t.Fatal(err)
		}
		v, _, err = fx.m.Wait(context.Background(), v.ID, "exit", 10*time.Second)
		if err != nil || v.Status != protocol.ProcessExited || *v.ExitCode != 0 {
			t.Fatalf("run: %+v %v", v, err)
		}
		return v
	}
	v := run()
	if v.Experiment != "train" || v.Run != "train#1" {
		t.Fatalf("named %q %q", v.Experiment, v.Run)
	}
	if err := fx.m.SetDashboardState(v.ID, "tab", json.RawMessage(`"loss"`)); err != nil {
		t.Fatal(err)
	}
	v = run()
	if v.Run != "train#2" || string(v.DashboardState["tab"]) != `"loss"` {
		t.Fatalf("second run %q, state %v", v.Run, v.DashboardState)
	}
	cat, err := fx.hub.Catalog(fx.home, "train")
	if err != nil || len(cat.Runs) != 2 || cat.Runs[0].Status != "exited" {
		t.Fatalf("catalog %+v %v", cat, err)
	}
	res, err := fx.hub.Query(fx.home, telemetry.Query{Metric: "loss"})
	if err != nil || len(res.Series) != 2 || res.X != "step" || len(res.Series[1].Points) != 2 {
		t.Fatalf("loss by run: %+v %v", res, err)
	}
	// The stat it reported is charted too.
	if res, _ := fx.hub.Query(fx.home, telemetry.Query{Metric: "epochs"}); len(res.Series) != 2 {
		t.Fatalf("epochs: %+v", res)
	}
	if _, err := os.Stat(filepath.Join(fx.home, telemetry.DBFile)); err != nil {
		t.Fatal(err)
	}
}
