package process

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

const (
	maxStats       = 32
	maxCheckpoints = 64
	maxURLs        = 8
	historyLen     = 60
	rateWindow     = 10 * time.Second
)

// CheckpointSpec declares a checkpoint at start.
type CheckpointSpec struct {
	Label   string `json:"label"`
	Pattern string `json:"pattern,omitempty"`
	Notify  bool   `json:"notify,omitempty"`
}

// StatSpec declares a stat at start.
type StatSpec struct {
	Key        string   `json:"key"`
	Label      string   `json:"label,omitempty"`
	Total      *float64 `json:"total,omitempty"`
	Unit       string   `json:"unit,omitempty"`
	NotifyWhen string   `json:"notify_when,omitempty"`
}

// event is something progress tells the model about.
type event struct {
	attrs      string // e.g. checkpoint="Tests pass"
	text       string
	checkpoint string // the checkpoint reached, if that's what happened
}

type sample struct {
	at time.Time
	v  float64
}

type stat struct {
	protocol.ProcessStat
	samples   []sample
	condition *condition
	met       bool // condition held at the last update
}

type condition struct {
	op string
	v  float64
}

var conditionRe = regexp.MustCompile(`^\s*(>=|<=|==|!=|>|<)\s*(-?[0-9.]+)\s*$`)

func parseCondition(s string) (*condition, error) {
	if strings.TrimSpace(s) == "" {
		return nil, nil
	}
	m := conditionRe.FindStringSubmatch(s)
	if m == nil {
		return nil, fmt.Errorf("notify_when %q: want an operator and a number, like \"> 0\"", s)
	}
	v, err := strconv.ParseFloat(m[2], 64)
	if err != nil {
		return nil, fmt.Errorf("notify_when %q: %w", s, err)
	}
	return &condition{op: m[1], v: v}, nil
}

func (c *condition) holds(v float64) bool {
	switch c.op {
	case ">":
		return v > c.v
	case ">=":
		return v >= c.v
	case "<":
		return v < c.v
	case "<=":
		return v <= c.v
	case "==":
		return v == c.v
	default:
		return v != c.v
	}
}

// progress is what a process has reported, from its output and from the
// model.
type progress struct {
	started     time.Time
	checkpoints []protocol.ProcessCheckpoint
	patterns    []*regexp.Regexp // by checkpoint; nil without one
	stats       []*stat
	statusText  string
	osc         *protocol.ProcessProgress
	url         string // the web UI link the model chose; replaces urls
	urls        []string
	lastLine    string
	widgets     []*protocol.ProcessWidget
	dashboard   string
}

// newProgress sets up the declared checkpoints and stats. prev has the
// previous run's checkpoint timings.
func newProgress(started time.Time, cps []CheckpointSpec, stats []StatSpec, prev map[string]int64) (*progress, error) {
	p := &progress{started: started}
	for _, c := range cps {
		if strings.TrimSpace(c.Label) == "" {
			return nil, fmt.Errorf("a checkpoint needs a label")
		}
		var re *regexp.Regexp
		if c.Pattern != "" {
			var err error
			if re, err = regexp.Compile(c.Pattern); err != nil {
				return nil, fmt.Errorf("checkpoint %q: %w", c.Label, err)
			}
		}
		cp := protocol.ProcessCheckpoint{Label: c.Label, Pattern: c.Pattern, Notify: c.Notify}
		if ms, ok := prev[c.Label]; ok {
			cp.PrevMs = &ms
		}
		p.checkpoints = append(p.checkpoints, cp)
		p.patterns = append(p.patterns, re)
	}
	for _, d := range stats {
		if !validKey(d.Key) {
			return nil, fmt.Errorf("stat key %q: use letters, digits, - and _", d.Key)
		}
		cond, err := parseCondition(d.NotifyWhen)
		if err != nil {
			return nil, err
		}
		s := p.stat(d.Key)
		s.Label, s.Total, s.Unit, s.NotifyWhen, s.condition = d.Label, d.Total, d.Unit, d.NotifyWhen, cond
	}
	return p, nil
}

var keyRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func validKey(k string) bool { return keyRe.MatchString(k) }

func (p *progress) stat(key string) *stat {
	for _, s := range p.stats {
		if s.Key == key {
			return s
		}
	}
	if len(p.stats) >= maxStats {
		return nil
	}
	s := &stat{ProcessStat: protocol.ProcessStat{Key: key}}
	p.stats = append(p.stats, s)
	return s
}

// line handles one line of plain output at log offset off.
func (p *progress) line(text string, off int64, now time.Time) []event {
	if strings.TrimSpace(text) != "" {
		p.lastLine = clip(text, 300)
	}
	var evs []event
	for i, re := range p.patterns {
		if re != nil && p.checkpoints[i].ReachedAt == nil && re.MatchString(text) {
			evs = append(evs, p.reach(i, off, now)...)
		}
	}
	for _, u := range localURLs(text) {
		p.addURL(u)
	}
	return evs
}

func (p *progress) addURL(u string) {
	for _, have := range p.urls {
		if have == u {
			return
		}
	}
	if len(p.urls) < maxURLs {
		p.urls = append(p.urls, u)
	}
}

func (p *progress) reach(i int, off int64, now time.Time) []event {
	cp := &p.checkpoints[i]
	at := now.UnixMilli()
	cp.ReachedAt, cp.Offset = &at, off
	if !cp.Notify {
		return nil
	}
	return []event{{
		attrs:      fmt.Sprintf("checkpoint=%q", cp.Label),
		text:       fmt.Sprintf("Reached checkpoint %q after %s.", cp.Label, shortDuration(now.Sub(p.started))),
		checkpoint: cp.Label,
	}}
}

// osc handles an OSC payload; only 9;4 (progress) matters.
func (p *progress) oscPayload(payload string) {
	rest, ok := strings.CutPrefix(payload, "9;4;")
	if !ok {
		return
	}
	parts := strings.Split(rest, ";")
	pct := 0
	if len(parts) > 1 {
		pct, _ = strconv.Atoi(parts[1])
	}
	pct = max(0, min(100, pct))
	switch parts[0] {
	case "0":
		p.osc = nil
	case "1":
		p.osc = &protocol.ProcessProgress{State: "normal", Percent: pct}
	case "2":
		p.osc = &protocol.ProcessProgress{State: "error", Percent: pct}
	case "3":
		p.osc = &protocol.ProcessProgress{State: "indeterminate"}
	case "4":
		p.osc = &protocol.ProcessProgress{State: "paused", Percent: pct}
	}
}

// report is one progress update, from the model (process_report) or the
// process itself (POST $EVERYWHERE_TELEMETRY/progress).
type report struct {
	Stat       string   `json:"stat,omitempty"`
	Value      *float64 `json:"value,omitempty"`
	Inc        *float64 `json:"inc,omitempty"`
	Total      *float64 `json:"total,omitempty"`
	Unit       string   `json:"unit,omitempty"`
	Label      string   `json:"label,omitempty"`
	Checkpoint string   `json:"checkpoint,omitempty"`
	Status     *string  `json:"status,omitempty"`
	Notify     string   `json:"notify,omitempty"`
	URL        string   `json:"url,omitempty"`

	// Widgets: declare one, or feed one by its id (see widgets.go).
	Widget *WidgetSpec `json:"widget,omitempty"`
	Plot   string      `json:"plot,omitempty"`
	Series string      `json:"series,omitempty"`
	X      *float64    `json:"x,omitempty"`
	Y      *float64    `json:"y,omitempty"`
	Bar    string      `json:"bar,omitempty"` // with label and value or inc
	Gauge  string      `json:"gauge,omitempty"`
	Row    string      `json:"row,omitempty"`
	Cells  []any       `json:"cells,omitempty"`
	// Set replaces a widget's data with Points (a line's, by series),
	// Bars, Rows or Value.
	Set    string                  `json:"set,omitempty"`
	Points map[string][][2]float64 `json:"points,omitempty"`
	Bars   []protocol.ProcessBar   `json:"bars,omitempty"`
	Rows   [][]any                 `json:"rows,omitempty"`

	// Dashboard shows .everywhere/dashboards/<name> for the process.
	Dashboard string `json:"dashboard,omitempty"`
	// Metrics are logged to its run's telemetry, at Step if given.
	Metrics map[string]float64 `json:"metrics,omitempty"`
	Step    *float64           `json:"step,omitempty"`
}

// hasWidget reports whether a report touches widgets.
func (r report) hasWidget() bool {
	return r.Widget != nil || r.Plot != "" || r.Bar != "" || r.Gauge != "" || r.Row != "" || r.Set != ""
}

// apply applies a report, returning what the model should hear about.
func (p *progress) apply(r report, off int64, now time.Time) []event {
	var evs []event
	if r.Stat != "" && validKey(r.Stat) {
		if s := p.stat(r.Stat); s != nil {
			if r.Label != "" {
				s.Label = clip(r.Label, 100)
			}
			if r.Unit != "" {
				s.Unit = clip(r.Unit, 20)
			}
			if r.Total != nil {
				s.Total = r.Total
			}
			switch {
			case r.Value != nil:
				s.Value = *r.Value
			case r.Inc != nil:
				s.Value += *r.Inc
			}
			if r.Value != nil || r.Inc != nil {
				s.record(now)
				p.plotStat(s, now)
				if s.condition != nil {
					met := s.condition.holds(s.Value)
					if met && !s.met {
						evs = append(evs, event{
							attrs: fmt.Sprintf("stat=%q", s.Key),
							text:  fmt.Sprintf("%s is now %s (notify_when %s).", statName(s), formatNum(s.Value), s.NotifyWhen),
						})
					}
					s.met = met
				}
			}
		}
	}
	if r.Checkpoint != "" {
		label := clip(r.Checkpoint, 100)
		found := false
		for i := range p.checkpoints {
			if p.checkpoints[i].Label == label {
				found = true
				if p.checkpoints[i].ReachedAt == nil {
					evs = append(evs, p.reach(i, off, now)...)
				}
				break
			}
		}
		if !found && len(p.checkpoints) < maxCheckpoints {
			at := now.UnixMilli()
			p.checkpoints = append(p.checkpoints, protocol.ProcessCheckpoint{Label: label, ReachedAt: &at, Offset: off})
			p.patterns = append(p.patterns, nil)
		}
	}
	if r.Status != nil {
		p.statusText = clip(*r.Status, 200)
	}
	if r.Notify != "" {
		evs = append(evs, event{attrs: `kind="notify"`, text: clip(r.Notify, 2000)})
	}
	if r.URL != "" && checkURL(r.URL) == nil {
		p.url = r.URL
	}
	if r.hasWidget() {
		_ = p.widgetReport(r, now) // a process's bad line is just ignored
	}
	if r.Dashboard != "" && validKey(r.Dashboard) {
		p.dashboard = r.Dashboard
	}
	return evs
}

// checkURL checks a web UI link the model chose.
func checkURL(s string) error {
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("url %q: give an http:// or https:// link", s)
	}
	return nil
}

// record samples the stat's value, at most once a second.
func (s *stat) record(now time.Time) {
	if n := len(s.samples); n > 0 && now.Sub(s.samples[n-1].at) < time.Second {
		s.samples[n-1].v = s.Value
		return
	}
	s.samples = append(s.samples, sample{now, s.Value})
	if len(s.samples) > historyLen {
		s.samples = append([]sample(nil), s.samples[len(s.samples)-historyLen:]...)
	}
}

// view is the stat with rate, ETA and history as of now. The rate runs from
// the newest sample at least rateWindow old (or the oldest) to now, so it
// falls off when updates stop.
func (s *stat) view(now time.Time) protocol.ProcessStat {
	v := s.ProcessStat
	v.History = make([]float64, len(s.samples))
	for i, x := range s.samples {
		v.History[i] = x.v
	}
	if len(s.samples) < 2 {
		return v
	}
	base := s.samples[0]
	for _, x := range s.samples {
		if now.Sub(x.at) >= rateWindow {
			base = x
		}
	}
	dt := now.Sub(base.at).Seconds()
	if dt < 1 {
		return v
	}
	rate := (s.Value - base.v) / dt
	v.Rate = &rate
	if s.Total != nil && rate > 0 && *s.Total > s.Value {
		eta := (*s.Total - s.Value) / rate
		v.ETA = &eta
	}
	return v
}

// fill copies the progress into a process view.
func (p *progress) fill(v *protocol.Process, now time.Time) {
	v.Checkpoints = append([]protocol.ProcessCheckpoint{}, p.checkpoints...)
	v.Stats = make([]protocol.ProcessStat, 0, len(p.stats))
	for _, s := range p.stats {
		v.Stats = append(v.Stats, s.view(now))
	}
	v.StatusText = p.statusText
	if p.osc != nil {
		o := *p.osc
		v.Progress = &o
	}
	if p.url != "" {
		v.URLs = []string{p.url}
	} else {
		v.URLs = append([]string(nil), p.urls...)
	}
	v.LastLine = p.lastLine
	v.Widgets = p.widgetViews()
	v.Dashboard = p.dashboard
}

// timings is how long after starting each reached checkpoint was reached.
func (p *progress) timings() map[string]int64 {
	out := map[string]int64{}
	for _, c := range p.checkpoints {
		if c.ReachedAt != nil {
			out[c.Label] = *c.ReachedAt - p.started.UnixMilli()
		}
	}
	return out
}

func statName(s *stat) string {
	if s.Label != "" {
		return s.Label
	}
	return s.Key
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && s[n]&0xc0 == 0x80 {
		n--
	}
	return s[:n] + "…"
}

func formatNum(f float64) string {
	if f == float64(int64(f)) {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

func shortDuration(d time.Duration) string {
	switch {
	case d < 10*time.Second:
		return fmt.Sprintf("%.1fs", d.Seconds())
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
	default:
		return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
	}
}
