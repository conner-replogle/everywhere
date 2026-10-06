package process

import (
	"encoding/json"
	"fmt"
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
	urls        []string
	lastLine    string
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
	if rest, ok := strings.CutPrefix(text, reportPrefix); ok {
		r, err := parseReport(rest)
		if err != nil {
			return nil
		}
		return p.apply(r, off, now)
	}
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

// report is one progress update, from a ::ew line or the model.
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
}

// parseReport parses what follows "::ew ".
func parseReport(s string) (report, error) {
	var r report
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "{") {
		err := json.Unmarshal([]byte(s), &r)
		return r, err
	}
	verb, rest, _ := strings.Cut(s, " ")
	rest = strings.TrimSpace(rest)
	switch verb {
	case "stat":
		toks := splitArgs(rest)
		if len(toks) < 2 {
			return r, fmt.Errorf("stat needs a key and a value")
		}
		r.Stat = toks[0].s
		v := toks[1].s
		if v != "" && (v[0] == '+' || v[0] == '-') && !strings.Contains(v, "/") {
			n, err := strconv.ParseFloat(v, 64)
			if err != nil {
				return r, err
			}
			r.Inc = &n
		} else {
			num, total, hasTotal := strings.Cut(v, "/")
			n, err := strconv.ParseFloat(num, 64)
			if err != nil {
				return r, err
			}
			r.Value = &n
			if hasTotal {
				t, err := strconv.ParseFloat(total, 64)
				if err != nil {
					return r, err
				}
				r.Total = &t
			}
		}
		var unit []string
		for _, t := range toks[2:] {
			if t.quoted {
				r.Label = t.s
			} else {
				unit = append(unit, t.s)
			}
		}
		r.Unit = strings.Join(unit, " ")
	case "checkpoint":
		r.Checkpoint = unquote(rest)
	case "status":
		st := unquote(rest)
		r.Status = &st
	case "notify":
		r.Notify = unquote(rest)
	default:
		return r, fmt.Errorf("unknown report %q", verb)
	}
	return r, nil
}

type arg struct {
	s      string
	quoted bool
}

// splitArgs splits on spaces, keeping "double" or 'single' quoted runs.
func splitArgs(s string) []arg {
	var out []arg
	for s = strings.TrimSpace(s); s != ""; s = strings.TrimSpace(s) {
		if q := s[0]; q == '"' || q == '\'' {
			end := strings.IndexByte(s[1:], q)
			if end < 0 {
				out = append(out, arg{s[1:], true})
				break
			}
			out = append(out, arg{s[1 : end+1], true})
			s = s[end+2:]
			continue
		}
		tok, rest, _ := strings.Cut(s, " ")
		out = append(out, arg{s: tok})
		s = rest
	}
	return out
}

func unquote(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && (s[0] == '"' || s[0] == '\'') && s[len(s)-1] == s[0] {
		return s[1 : len(s)-1]
	}
	return s
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
	return evs
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
	v.URLs = append([]string(nil), p.urls...)
	v.LastLine = p.lastLine
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
