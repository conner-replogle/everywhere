// Package telemetry keeps what processes report about themselves (metrics,
// events, progress) in their project, .everywhere/telemetry.db, and answers
// the queries charts make. Processes push it over loopback HTTP (see
// ingest.go), never through their output; the daemon is the only writer.
//
// A metric's points belong to a series: a name plus labels, two of which
// are always set: experiment (what runs are compared within, e.g. "train")
// and run (one run of it, e.g. "train#3" or "v2"). Data outlives the
// processes that wrote it, so a finished run's charts still work and runs
// can be compared.
package telemetry

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// File is the database's path in a project.
const DBFile = ".everywhere/telemetry.db"

// maxBytes is how big a project's telemetry may get before its oldest
// finished runs are dropped.
const maxBytes = 1 << 30

var schema = []string{`
CREATE TABLE IF NOT EXISTS runs (
  experiment TEXT NOT NULL,
  run        TEXT NOT NULL,
  process    TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  status     TEXT NOT NULL DEFAULT 'running',
  PRIMARY KEY (experiment, run)
);
CREATE TABLE IF NOT EXISTS series (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  experiment TEXT NOT NULL,
  run        TEXT NOT NULL,
  labels     TEXT NOT NULL,
  UNIQUE (name, labels)
);
CREATE INDEX IF NOT EXISTS series_experiment ON series (experiment, name);
CREATE TABLE IF NOT EXISTS points (
  series INTEGER NOT NULL,
  ts     INTEGER NOT NULL,
  step   REAL,
  value  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS points_ts ON points (series, ts);
CREATE INDEX IF NOT EXISTS points_step ON points (series, step) WHERE step IS NOT NULL;
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  experiment TEXT NOT NULL,
  run        TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events (experiment, run, id);
CREATE TABLE IF NOT EXISTS dashboard_state (
  dashboard TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (dashboard, key)
);
`}

// db is one project's telemetry.
type db struct {
	sql    *sql.DB
	mu     sync.Mutex
	series map[string]int64 // by name + labels
}

func openDB(home string) (*db, error) {
	path := filepath.Join(home, DBFile)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	gitignore(filepath.Dir(path))
	conn, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	conn.SetMaxOpenConns(1)
	for _, s := range schema {
		if _, err := conn.Exec(s); err != nil {
			conn.Close()
			return nil, fmt.Errorf("telemetry schema: %w", err)
		}
	}
	return &db{sql: conn, series: map[string]int64{}}, nil
}

// gitignore keeps telemetry out of git, next to the dashboards that are in.
func gitignore(dir string) {
	const content = "# Written by the everywhere daemon: what it writes, and what processes report.\ntypes/\ntelemetry.db*\nfiles/\n"
	path := filepath.Join(dir, ".gitignore")
	b, err := os.ReadFile(path)
	if err == nil && (string(b) == content || !strings.HasPrefix(string(b), "# Written by the everywhere daemon")) {
		return
	}
	_ = os.WriteFile(path, []byte(content), 0o644)
}

// Point is one value of a metric.
type Point struct {
	Name   string
	Labels map[string]string // with experiment and run
	TS     int64             // unix ms
	Step   *float64
	Value  float64
}

// Event is something discrete a run reported: a checkpoint, a file it
// wrote, a log record.
type Event struct {
	ID         int64           `json:"id"`
	Experiment string          `json:"experiment"`
	Run        string          `json:"run"`
	TS         int64           `json:"ts"`
	Kind       string          `json:"kind"`
	Data       json.RawMessage `json:"data"`
}

// Run is one run of an experiment.
type Run struct {
	Experiment string `json:"experiment"`
	Run        string `json:"run"`
	Process    string `json:"process,omitempty"`
	StartedAt  int64  `json:"startedAt"`
	EndedAt    *int64 `json:"endedAt,omitempty"`
	Status     string `json:"status"`
}

func labelsKey(name string, labels map[string]string) (string, string) {
	b, _ := json.Marshal(labels) // keys come out sorted
	return name + "\x00" + string(b), string(b)
}

// write stores points and events in one transaction.
func (d *db) write(points []Point, events []Event) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	tx, err := d.sql.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, p := range points {
		key, labels := labelsKey(p.Name, p.Labels)
		id, ok := d.series[key]
		if !ok {
			if err := tx.QueryRow(`SELECT id FROM series WHERE name = ? AND labels = ?`, p.Name, labels).Scan(&id); errors.Is(err, sql.ErrNoRows) {
				res, err := tx.Exec(`INSERT INTO series (name, experiment, run, labels) VALUES (?, ?, ?, ?)`,
					p.Name, p.Labels["experiment"], p.Labels["run"], labels)
				if err != nil {
					return err
				}
				id, _ = res.LastInsertId()
			} else if err != nil {
				return err
			}
		}
		var step any
		if p.Step != nil {
			step = *p.Step
		}
		if _, err := tx.Exec(`INSERT INTO points (series, ts, step, value) VALUES (?, ?, ?, ?)`, id, p.TS, step, p.Value); err != nil {
			return err
		}
		d.series[key] = id
	}
	for _, e := range events {
		if _, err := tx.Exec(`INSERT INTO events (experiment, run, ts, kind, data) VALUES (?, ?, ?, ?, ?)`,
			e.Experiment, e.Run, e.TS, e.Kind, string(e.Data)); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		// The series ids cached in this transaction may not exist.
		d.series = map[string]int64{}
		return err
	}
	return nil
}

func (d *db) startRun(r Run) error {
	_, err := d.sql.Exec(`INSERT INTO runs (experiment, run, process, started_at, status) VALUES (?, ?, ?, ?, 'running')
ON CONFLICT (experiment, run) DO UPDATE SET process = excluded.process, started_at = excluded.started_at, ended_at = NULL, status = 'running'`,
		r.Experiment, r.Run, r.Process, r.StartedAt)
	return err
}

func (d *db) endRun(experiment, run, status string, at int64) error {
	_, err := d.sql.Exec(`UPDATE runs SET ended_at = ?, status = ? WHERE experiment = ? AND run = ?`, at, status, experiment, run)
	return err
}

// nextRun names a new run of an experiment, <experiment>#<n>, past the
// stored runs and those in taken (started, but with no data yet).
func (d *db) nextRun(experiment string, taken map[string]bool) (string, error) {
	rows, err := d.sql.Query(`SELECT run FROM runs WHERE experiment = ?`, experiment)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	n := 0
	names := make([]string, 0, len(taken))
	for r := range taken {
		names = append(names, r)
	}
	for rows.Next() {
		var r string
		if err := rows.Scan(&r); err != nil {
			return "", err
		}
		names = append(names, r)
	}
	for _, r := range names {
		var k int
		if _, err := fmt.Sscanf(strings.TrimPrefix(r, experiment+"#"), "%d", &k); err == nil && strings.HasPrefix(r, experiment+"#") {
			n = max(n, k)
		}
	}
	return fmt.Sprintf("%s#%d", experiment, n+1), rows.Err()
}

// Catalog is what an experiment (or a project) has: its runs and metrics.
type Catalog struct {
	Runs    []Run        `json:"runs"`
	Metrics []MetricInfo `json:"metrics"`
}

// MetricInfo is a metric and the label values it has.
type MetricInfo struct {
	Name   string              `json:"name"`
	Labels map[string][]string `json:"labels"`
	// Steps: some of its points have a step, so it's best drawn over steps.
	Steps bool `json:"steps"`
}

func (d *db) catalog(experiment string) (Catalog, error) {
	c := Catalog{Runs: []Run{}, Metrics: []MetricInfo{}}
	// Only runs with data: a process that never reported isn't one to show.
	q := `SELECT experiment, run, process, started_at, ended_at, status FROM runs r
WHERE (EXISTS (SELECT 1 FROM series s WHERE s.experiment = r.experiment AND s.run = r.run)
    OR EXISTS (SELECT 1 FROM events e WHERE e.experiment = r.experiment AND e.run = r.run))`
	var args []any
	if experiment != "" {
		q += ` AND experiment = ?`
		args = append(args, experiment)
	}
	rows, err := d.sql.Query(q+` ORDER BY started_at`, args...)
	if err != nil {
		return c, err
	}
	for rows.Next() {
		var r Run
		var ended sql.NullInt64
		if err := rows.Scan(&r.Experiment, &r.Run, &r.Process, &r.StartedAt, &ended, &r.Status); err != nil {
			rows.Close()
			return c, err
		}
		if ended.Valid {
			r.EndedAt = &ended.Int64
		}
		c.Runs = append(c.Runs, r)
	}
	rows.Close()

	q = `SELECT s.id, s.name, s.labels FROM series s`
	if experiment != "" {
		q += ` WHERE s.experiment = ?`
	}
	rows, err = d.sql.Query(q+` ORDER BY s.name`, args...)
	if err != nil {
		return c, err
	}
	byName := map[string]*MetricInfo{}
	var ids []int64
	var names []string
	for rows.Next() {
		var id int64
		var name, labels string
		if err := rows.Scan(&id, &name, &labels); err != nil {
			rows.Close()
			return c, err
		}
		m := byName[name]
		if m == nil {
			m = &MetricInfo{Name: name, Labels: map[string][]string{}}
			byName[name] = m
			c.Metrics = append(c.Metrics, MetricInfo{})
		}
		var l map[string]string
		_ = json.Unmarshal([]byte(labels), &l)
		for k, v := range l {
			if !contains(m.Labels[k], v) {
				m.Labels[k] = append(m.Labels[k], v)
			}
		}
		ids = append(ids, id)
		names = append(names, name)
	}
	rows.Close()
	for i, id := range ids {
		m := byName[names[i]]
		if m.Steps {
			continue
		}
		var one int
		if err := d.sql.QueryRow(`SELECT 1 FROM points WHERE series = ? AND step IS NOT NULL LIMIT 1`, id).Scan(&one); err == nil {
			m.Steps = true
		}
	}
	c.Metrics = c.Metrics[:0]
	for _, m := range byName {
		for k := range m.Labels {
			sort.Strings(m.Labels[k])
		}
		c.Metrics = append(c.Metrics, *m)
	}
	sort.Slice(c.Metrics, func(i, j int) bool { return c.Metrics[i].Name < c.Metrics[j].Name })
	return c, nil
}

// Query asks for a metric's values, bucketed for drawing.
type Query struct {
	Metric string `json:"metric"`
	// Where filters by label (experiment, run, or any other); a value list
	// matches any of them.
	Where map[string][]string `json:"where,omitempty"`
	// GroupBy splits the result into a series per value of these labels;
	// series in one group are merged. Default: run.
	GroupBy []string `json:"groupBy,omitempty"`
	// X is "step" or "time" (seconds since the run started). Default: step
	// when the metric has steps.
	X string `json:"x,omitempty"`
	// From and To bound x; either may be left out.
	From *float64 `json:"from,omitempty"`
	To   *float64 `json:"to,omitempty"`
	// Points is about how many points a series comes back as (the chart's
	// width): the range is cut into this many buckets, each the mean of its
	// values. Default 400, at most 2000.
	Points int `json:"points,omitempty"`
}

// Series is one line of a query's answer.
type Series struct {
	Labels map[string]string `json:"labels"`
	// Points are [x, mean]; Min and Max the bucket's extremes, in step.
	Points [][2]float64 `json:"points"`
	Min    []float64    `json:"min"`
	Max    []float64    `json:"max"`
}

// Result answers a Query.
type Result struct {
	X      string   `json:"x"`
	Series []Series `json:"series"`
}

type seriesRow struct {
	id      int64
	labels  map[string]string
	started int64
}

func (d *db) query(q Query) (Result, error) {
	res := Result{Series: []Series{}}
	if q.Metric == "" {
		return res, errors.New("query: give a metric")
	}
	points := q.Points
	if points <= 0 {
		points = 400
	}
	points = min(points, 2000)
	groupBy := q.GroupBy
	if groupBy == nil {
		groupBy = []string{"run"}
	}

	rows, err := d.sql.Query(`SELECT s.id, s.labels, COALESCE(r.started_at, 0) FROM series s
LEFT JOIN runs r ON r.experiment = s.experiment AND r.run = s.run WHERE s.name = ?`, q.Metric)
	if err != nil {
		return res, err
	}
	var matched []seriesRow
	for rows.Next() {
		var s seriesRow
		var labels string
		if err := rows.Scan(&s.id, &labels, &s.started); err != nil {
			rows.Close()
			return res, err
		}
		_ = json.Unmarshal([]byte(labels), &s.labels)
		if matches(s.labels, q.Where) {
			matched = append(matched, s)
		}
	}
	rows.Close()
	if len(matched) == 0 {
		res.X = q.X
		if res.X == "" {
			res.X = "time"
		}
		return res, nil
	}

	x := q.X
	if x == "" {
		x = "time"
		for _, s := range matched {
			var one int
			if d.sql.QueryRow(`SELECT 1 FROM points WHERE series = ? AND step IS NOT NULL LIMIT 1`, s.id).Scan(&one) == nil {
				x = "step"
				break
			}
		}
	}
	if x != "step" && x != "time" {
		return res, fmt.Errorf("query: x is step or time, not %q", x)
	}
	res.X = x
	// x as SQL: a step, or seconds since the run started.
	xExpr := func(s seriesRow) (string, []any) {
		if x == "step" {
			return "step", nil
		}
		return "(ts - ?) / 1000.0", []any{s.started}
	}

	// The x range over every matched series, unless given.
	lo, hi := math.Inf(1), math.Inf(-1)
	for _, s := range matched {
		e, a := xExpr(s)
		var mn, mx sql.NullFloat64
		cond := ""
		if x == "step" {
			cond = " AND step IS NOT NULL"
		}
		if err := d.sql.QueryRow(`SELECT MIN(`+e+`), MAX(`+e+`) FROM points WHERE series = ?`+cond,
			append(append(a, a...), s.id)...).Scan(&mn, &mx); err != nil {
			return res, err
		}
		if mn.Valid {
			lo, hi = math.Min(lo, mn.Float64), math.Max(hi, mx.Float64)
		}
	}
	if q.From != nil {
		lo = *q.From
	}
	if q.To != nil {
		hi = *q.To
	}
	if math.IsInf(lo, 0) || math.IsInf(hi, 0) || hi < lo {
		return res, nil
	}
	width := (hi - lo) / float64(points)
	if width <= 0 {
		width = 1
	}

	type bucket struct{ sum, n, lo, hi, x float64 }
	groups := map[string]map[int64]*bucket{}
	groupLabels := map[string]map[string]string{}
	var order []string
	for _, s := range matched {
		gl := map[string]string{}
		for _, k := range groupBy {
			if v, ok := s.labels[k]; ok {
				gl[k] = v
			}
		}
		gk, _ := labelsKey("", gl)
		if groups[gk] == nil {
			groups[gk] = map[int64]*bucket{}
			groupLabels[gk] = gl
			order = append(order, gk)
		}
		e, a := xExpr(s)
		args := append([]any{}, a...)
		args = append(args, lo, width)
		args = append(args, a...)
		args = append(args, s.id)
		args = append(args, a...)
		args = append(args, lo)
		args = append(args, a...)
		args = append(args, hi)
		rows, err := d.sql.Query(`SELECT CAST((`+e+` - ?) / ? AS INTEGER) AS b, SUM(value), COUNT(*), MIN(value), MAX(value), AVG(`+e+`)
FROM points WHERE series = ? AND `+e+` >= ? AND `+e+` <= ? GROUP BY b`, args...)
		if err != nil {
			return res, err
		}
		for rows.Next() {
			var b int64
			var sum, n, mn, mx, bx float64
			if err := rows.Scan(&b, &sum, &n, &mn, &mx, &bx); err != nil {
				rows.Close()
				return res, err
			}
			have := groups[gk][b]
			if have == nil {
				groups[gk][b] = &bucket{sum, n, mn, mx, bx * n}
				continue
			}
			have.sum, have.n = have.sum+sum, have.n+n
			have.lo, have.hi = math.Min(have.lo, mn), math.Max(have.hi, mx)
			have.x += bx * n
		}
		rows.Close()
	}
	sort.Strings(order)
	for _, gk := range order {
		bs := groups[gk]
		keys := make([]int64, 0, len(bs))
		for k := range bs {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
		s := Series{Labels: groupLabels[gk], Points: make([][2]float64, 0, len(keys))}
		for _, k := range keys {
			b := bs[k]
			s.Points = append(s.Points, [2]float64{b.x / b.n, b.sum / b.n})
			s.Min = append(s.Min, b.lo)
			s.Max = append(s.Max, b.hi)
		}
		res.Series = append(res.Series, s)
	}
	return res, nil
}

func matches(labels map[string]string, where map[string][]string) bool {
	for k, vs := range where {
		if len(vs) == 0 {
			continue
		}
		if !contains(vs, labels[k]) {
			return false
		}
	}
	return true
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// events returns an experiment's events, newest first: of some runs and
// kind if given, before an id, at most limit.
func (d *db) events(experiment string, runs []string, kind string, before int64, limit int) ([]Event, error) {
	q := `SELECT id, experiment, run, ts, kind, data FROM events WHERE experiment = ?`
	args := []any{experiment}
	if len(runs) > 0 {
		q += ` AND run IN (` + strings.TrimSuffix(strings.Repeat("?,", len(runs)), ",") + `)`
		for _, r := range runs {
			args = append(args, r)
		}
	}
	if kind != "" {
		q += ` AND kind = ?`
		args = append(args, kind)
	}
	if before > 0 {
		q += ` AND id < ?`
		args = append(args, before)
	}
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	q += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := d.sql.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		var data string
		if err := rows.Scan(&e.ID, &e.Experiment, &e.Run, &e.TS, &e.Kind, &data); err != nil {
			return nil, err
		}
		e.Data = json.RawMessage(data)
		out = append(out, e)
	}
	return out, rows.Err()
}

func (d *db) dashboardState(dashboard string) (map[string]json.RawMessage, error) {
	rows, err := d.sql.Query(`SELECT key, value FROM dashboard_state WHERE dashboard = ?`, dashboard)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out map[string]json.RawMessage
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		if out == nil {
			out = map[string]json.RawMessage{}
		}
		out[k] = json.RawMessage(v)
	}
	return out, rows.Err()
}

func (d *db) setDashboardState(dashboard, key string, value json.RawMessage) error {
	if len(value) == 0 || string(value) == "null" {
		_, err := d.sql.Exec(`DELETE FROM dashboard_state WHERE dashboard = ? AND key = ?`, dashboard, key)
		return err
	}
	var n int
	_ = d.sql.QueryRow(`SELECT COUNT(*) FROM dashboard_state WHERE dashboard = ? AND key != ?`, dashboard, key).Scan(&n)
	if n >= maxStateKeys {
		return fmt.Errorf("at most %d state keys", maxStateKeys)
	}
	_, err := d.sql.Exec(`INSERT INTO dashboard_state (dashboard, key, value) VALUES (?, ?, ?)
ON CONFLICT (dashboard, key) DO UPDATE SET value = excluded.value`, dashboard, key, string(value))
	return err
}

// trim drops the oldest finished runs while the data is over maxBytes.
func (d *db) trim(limit int64) error {
	for range 20 {
		var pages, free, size int64
		_ = d.sql.QueryRow(`PRAGMA page_count`).Scan(&pages)
		_ = d.sql.QueryRow(`PRAGMA freelist_count`).Scan(&free)
		_ = d.sql.QueryRow(`PRAGMA page_size`).Scan(&size)
		if (pages-free)*size <= limit {
			return nil
		}
		var exp, run string
		err := d.sql.QueryRow(`SELECT experiment, run FROM runs WHERE ended_at IS NOT NULL ORDER BY started_at LIMIT 1`).Scan(&exp, &run)
		if err != nil {
			return nil // nothing finished to drop
		}
		if err := d.deleteRun(exp, run); err != nil {
			return err
		}
	}
	return nil
}

func (d *db) deleteRun(experiment, run string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	tx, err := d.sql.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range []string{
		`DELETE FROM points WHERE series IN (SELECT id FROM series WHERE experiment = ? AND run = ?)`,
		`DELETE FROM series WHERE experiment = ? AND run = ?`,
		`DELETE FROM events WHERE experiment = ? AND run = ?`,
		`DELETE FROM runs WHERE experiment = ? AND run = ?`,
	} {
		if _, err := tx.Exec(q, experiment, run); err != nil {
			return err
		}
	}
	d.series = map[string]int64{}
	return tx.Commit()
}

func now() int64 { return time.Now().UnixMilli() }
