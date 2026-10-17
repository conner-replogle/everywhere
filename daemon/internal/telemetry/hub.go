package telemetry

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"
)

const (
	flushEvery = time.Second
	trimEvery  = 5 * time.Minute
	// tokenGrace keeps a run's token working briefly after its process
	// ends, for what it sent on the way out.
	tokenGrace   = 10 * time.Second
	maxStateKeys = 64
	maxStateLen  = 16 << 10
)

var (
	nameRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,127}$`)
	keyRe  = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`)
)

// RunInfo is a run a process reports as.
type RunInfo struct {
	Token      string
	Home       string
	Experiment string
	Run        string
	Process    string
}

type batch struct {
	points []Point
	events []Event
}

// Hub is the daemon's telemetry: the ingest endpoint processes push to, and
// every project's store.
type Hub struct {
	// OnChange is told which experiments' metrics got new data in a
	// project, at most every flushEvery.
	OnChange func(home string, changed map[string][]string)
	// OnProgress applies a progress report (process_report's fields) a
	// process sent to /progress.
	OnProgress func(processID string, report json.RawMessage) error

	mu      sync.Mutex
	dbs     map[string]*db
	pending map[string]*batch
	tokens  map[string]*RunInfo
	addr    string
	srv     *http.Server
	done    chan struct{}
	closed  bool
}

func New() *Hub {
	return &Hub{dbs: map[string]*db{}, pending: map[string]*batch{}, tokens: map[string]*RunInfo{}, done: make(chan struct{})}
}

// Start listens on loopback and starts writing batches.
func (h *Hub) Start() error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	h.addr = "http://" + ln.Addr().String()
	h.srv = &http.Server{Handler: h.handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := h.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Warn("telemetry endpoint stopped", "err", err)
		}
	}()
	go h.loop()
	return nil
}

// Addr is the ingest endpoint's URL.
func (h *Hub) Addr() string { return h.addr }

// Close writes what's pending and closes the stores.
func (h *Hub) Close() {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	h.closed = true
	close(h.done)
	h.mu.Unlock()
	if h.srv != nil {
		_ = h.srv.Close()
	}
	h.flush()
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, d := range h.dbs {
		_ = d.sql.Close()
	}
	h.dbs = map[string]*db{}
}

func (h *Hub) loop() {
	tick := time.NewTicker(flushEvery)
	defer tick.Stop()
	lastTrim := time.Now()
	for {
		select {
		case <-h.done:
			return
		case <-tick.C:
			h.flush()
			if time.Since(lastTrim) > trimEvery {
				lastTrim = time.Now()
				h.mu.Lock()
				dbs := make([]*db, 0, len(h.dbs))
				for _, d := range h.dbs {
					dbs = append(dbs, d)
				}
				h.mu.Unlock()
				for _, d := range dbs {
					if err := d.trim(maxBytes); err != nil {
						slog.Warn("trimming telemetry", "err", err)
					}
				}
			}
		}
	}
}

// flush writes every project's pending batch.
func (h *Hub) flush() {
	h.mu.Lock()
	pending := h.pending
	h.pending = map[string]*batch{}
	h.mu.Unlock()
	for home, b := range pending {
		h.write(home, b)
	}
}

// write stores a project's batch and says what changed.
func (h *Hub) write(home string, b *batch) {
	d, err := h.db(home)
	if err != nil {
		slog.Warn("telemetry store", "home", home, "err", err)
		return
	}
	if err := d.write(b.points, b.events); err != nil {
		slog.Warn("writing telemetry", "home", home, "err", err)
		return
	}
	if h.OnChange == nil {
		return
	}
	changed := map[string][]string{}
	for _, p := range b.points {
		exp := p.Labels["experiment"]
		if !contains(changed[exp], p.Name) {
			changed[exp] = append(changed[exp], p.Name)
		}
	}
	for _, e := range b.events {
		if _, ok := changed[e.Experiment]; !ok {
			changed[e.Experiment] = []string{}
		}
	}
	for _, names := range changed {
		sort.Strings(names)
	}
	h.OnChange(home, changed)
}

// db opens (once) a project's store.
func (h *Hub) db(home string) (*db, error) {
	if home == "" {
		return nil, errors.New("no project")
	}
	home = filepath.Clean(home)
	h.mu.Lock()
	defer h.mu.Unlock()
	if d := h.dbs[home]; d != nil {
		return d, nil
	}
	d, err := openDB(home)
	if err != nil {
		return nil, err
	}
	h.dbs[home] = d
	return d, nil
}

func (h *Hub) add(home string, points []Point, events []Event) {
	home = filepath.Clean(home)
	h.mu.Lock()
	defer h.mu.Unlock()
	b := h.pending[home]
	if b == nil {
		b = &batch{}
		h.pending[home] = b
	}
	b.points = append(b.points, points...)
	b.events = append(b.events, events...)
}

// StartRun starts a run of an experiment in a project (named <experiment>#N
// unless run is given) and returns its token.
func (h *Hub) StartRun(home, experiment, run, processID string) (RunInfo, error) {
	if !keyRe.MatchString(experiment) {
		return RunInfo{}, fmt.Errorf("experiment %q: use letters, digits, ., - and _", experiment)
	}
	if run != "" && !nameRe.MatchString(run) {
		return RunInfo{}, fmt.Errorf("run %q: use letters, digits, ., :, /, #, - and _", run)
	}
	d, err := h.db(home)
	if err != nil {
		return RunInfo{}, err
	}
	if run == "" {
		if run, err = d.nextRun(experiment); err != nil {
			return RunInfo{}, err
		}
	}
	if err := d.startRun(Run{Experiment: experiment, Run: run, Process: processID, StartedAt: now()}); err != nil {
		return RunInfo{}, err
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	info := RunInfo{Token: hex.EncodeToString(b), Home: filepath.Clean(home), Experiment: experiment, Run: run, Process: processID}
	h.mu.Lock()
	h.tokens[info.Token] = &info
	h.mu.Unlock()
	return info, nil
}

// EndRun marks a run ended; its token stops working a little later.
func (h *Hub) EndRun(info RunInfo, status string) {
	if info.Home == "" || info.Experiment == "" {
		return
	}
	if d, err := h.db(info.Home); err == nil {
		_ = d.endRun(info.Experiment, info.Run, status, now())
	}
	if info.Token != "" {
		time.AfterFunc(tokenGrace, func() {
			h.mu.Lock()
			delete(h.tokens, info.Token)
			h.mu.Unlock()
		})
	}
}

// Env is what a process gets to report as its run: everywhere's own
// endpoint, and the standard OpenTelemetry settings, so any OTel SDK
// exports here with no setup.
func (h *Hub) Env(info RunInfo) []string {
	if h.addr == "" {
		return nil
	}
	return []string{
		"EVERYWHERE_TELEMETRY=" + h.addr,
		"EVERYWHERE_TOKEN=" + info.Token,
		"EVERYWHERE_EXPERIMENT=" + info.Experiment,
		"EVERYWHERE_RUN=" + info.Run,
		"OTEL_EXPORTER_OTLP_ENDPOINT=" + h.addr,
		"OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
		"OTEL_EXPORTER_OTLP_HEADERS=x-everywhere-token=" + info.Token,
		"OTEL_METRIC_EXPORT_INTERVAL=1000",
		"OTEL_SERVICE_NAME=" + info.Experiment,
		"OTEL_RESOURCE_ATTRIBUTES=everywhere.experiment=" + info.Experiment + ",everywhere.run=" + info.Run,
	}
}

// Log records metrics for a run, as /log does: for what the model reports
// itself (process_report on a tracker).
func (h *Hub) Log(info RunInfo, step *float64, metrics map[string]float64, labels map[string]string) error {
	points, err := logPoints(info, logEntry{Step: step, Metrics: metrics, Labels: labels}, now())
	if err != nil {
		return err
	}
	h.add(info.Home, points, nil)
	return nil
}

// Catalog lists an experiment's (or, with no experiment, a project's) runs
// and metrics.
func (h *Hub) Catalog(home, experiment string) (Catalog, error) {
	h.flushHome(home)
	d, err := h.db(home)
	if err != nil {
		return Catalog{}, err
	}
	return d.catalog(experiment)
}

// Query answers a chart's query.
func (h *Hub) Query(home string, q Query) (Result, error) {
	h.flushHome(home)
	d, err := h.db(home)
	if err != nil {
		return Result{}, err
	}
	return d.query(q)
}

// Events lists an experiment's events, newest first.
func (h *Hub) Events(home, experiment string, runs []string, kind string, before int64, limit int) ([]Event, error) {
	h.flushHome(home)
	d, err := h.db(home)
	if err != nil {
		return nil, err
	}
	return d.events(experiment, runs, kind, before, limit)
}

// DeleteRun forgets a run's data.
func (h *Hub) DeleteRun(home, experiment, run string) error {
	d, err := h.db(home)
	if err != nil {
		return err
	}
	return d.deleteRun(experiment, run)
}

// DashboardState is a dashboard's own state in a project.
func (h *Hub) DashboardState(home, dashboard string) (map[string]json.RawMessage, error) {
	d, err := h.db(home)
	if err != nil {
		return nil, err
	}
	return d.dashboardState(dashboard)
}

// SetDashboardState sets a key of a dashboard's state; null removes it.
func (h *Hub) SetDashboardState(home, dashboard, key string, value json.RawMessage) error {
	if !keyRe.MatchString(key) {
		return fmt.Errorf("state key %q: use letters, digits, ., - and _", key)
	}
	if len(value) > maxStateLen {
		return fmt.Errorf("state %s: %d KB is over the %d KB a value can be", key, len(value)>>10, maxStateLen>>10)
	}
	if len(value) > 0 && !json.Valid(value) {
		return fmt.Errorf("state %s: not JSON", key)
	}
	d, err := h.db(home)
	if err != nil {
		return err
	}
	return d.setDashboardState(dashboard, key, value)
}

// flushHome writes a project's pending batch now, so a query sees it.
func (h *Hub) flushHome(home string) {
	home = filepath.Clean(home)
	h.mu.Lock()
	b := h.pending[home]
	delete(h.pending, home)
	h.mu.Unlock()
	if b != nil {
		h.write(home, b)
	}
}

func (h *Hub) token(r *http.Request) *RunInfo {
	tok := r.Header.Get("X-Everywhere-Token")
	if tok == "" {
		if a := r.Header.Get("Authorization"); len(a) > 7 && a[:7] == "Bearer " {
			tok = a[7:]
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.tokens[tok]
}
