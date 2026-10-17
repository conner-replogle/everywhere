package process

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

const (
	maxWidgets = 8
	maxSeries  = 4
	maxPoints  = 240 // per series; older points thin out past it
	maxBars    = 40
	maxRows    = 100 // the oldest row goes past it
	maxColumns = 8
)

// WidgetSpec declares a widget: at start, with process_report, or from the
// process (POST /progress).
type WidgetSpec struct {
	ID       string   `json:"id"`
	Kind     string   `json:"kind"`
	Title    string   `json:"title,omitempty"`
	Unit     string   `json:"unit,omitempty"`
	Stats    []string `json:"stats,omitempty"`
	Stat     string   `json:"stat,omitempty"`
	XLabel   string   `json:"x_label,omitempty"`
	Min      *float64 `json:"min,omitempty"`
	Max      *float64 `json:"max,omitempty"`
	Warn     *float64 `json:"warn,omitempty"`
	Critical *float64 `json:"critical,omitempty"`
	Columns  []string `json:"columns,omitempty"`
}

func (s WidgetSpec) check() error {
	if !validKey(s.ID) {
		return fmt.Errorf("widget id %q: use letters, digits, - and _", s.ID)
	}
	for _, k := range append(append([]string(nil), s.Stats...), s.Stat) {
		if k != "" && !validKey(k) {
			return fmt.Errorf("widget %s: stat key %q: use letters, digits, - and _", s.ID, k)
		}
	}
	switch s.Kind {
	case protocol.WidgetLine:
		if len(s.Stats) > maxSeries {
			return fmt.Errorf("widget %s: a line chart takes at most %d series", s.ID, maxSeries)
		}
		if len(s.Stats) > 0 && s.XLabel != "" {
			return fmt.Errorf("widget %s: a line of stats is over time; leave out x_label", s.ID)
		}
	case protocol.WidgetBar:
		if len(s.Stats) > maxBars {
			return fmt.Errorf("widget %s: a bar chart takes at most %d bars", s.ID, maxBars)
		}
	case protocol.WidgetGauge:
		if s.Max == nil && s.Stat == "" {
			return fmt.Errorf("widget %s: a gauge needs a max, or a stat with a total", s.ID)
		}
	case protocol.WidgetTable:
		if len(s.Columns) == 0 || len(s.Columns) > maxColumns {
			return fmt.Errorf("widget %s: a table needs 1 to %d columns", s.ID, maxColumns)
		}
	default:
		return fmt.Errorf("widget %s: kind %q: use line, bar, gauge or table", s.ID, s.Kind)
	}
	return nil
}

// addWidget declares a widget. Declaring an id again changes it, keeping its
// data unless the kind changed.
func (p *progress) addWidget(s WidgetSpec) error {
	if err := s.check(); err != nil {
		return err
	}
	w := p.widget(s.ID)
	switch {
	case w == nil:
		if len(p.widgets) >= maxWidgets {
			return fmt.Errorf("at most %d widgets", maxWidgets)
		}
		w = &protocol.ProcessWidget{ID: s.ID, Kind: s.Kind}
		p.widgets = append(p.widgets, w)
	case w.Kind != s.Kind:
		*w = protocol.ProcessWidget{ID: s.ID, Kind: s.Kind}
	}
	w.Title, w.Unit, w.XLabel = clip(s.Title, 100), clip(s.Unit, 20), clip(s.XLabel, 40)
	w.Stats, w.Stat = s.Stats, s.Stat
	w.Min, w.Max, w.Warn, w.Critical = s.Min, s.Max, s.Warn, s.Critical
	w.Columns = make([]string, len(s.Columns))
	for i, c := range s.Columns {
		w.Columns[i] = clip(c, 60)
	}
	for _, k := range s.Stats {
		if w.Kind == protocol.WidgetLine {
			p.series(w, k)
		}
	}
	return nil
}

func (p *progress) widget(id string) *protocol.ProcessWidget {
	for _, w := range p.widgets {
		if w.ID == id {
			return w
		}
	}
	return nil
}

func (p *progress) widgetOf(id, kind string) (*protocol.ProcessWidget, error) {
	w := p.widget(id)
	if w == nil {
		return nil, fmt.Errorf("no widget %q; declare it first", id)
	}
	if w.Kind != kind {
		return nil, fmt.Errorf("widget %q is a %s, not a %s", id, w.Kind, kind)
	}
	return w, nil
}

// series finds or adds a line's series; nil if it has too many.
func (p *progress) series(w *protocol.ProcessWidget, key string) *protocol.ProcessSeries {
	for i := range w.Series {
		if w.Series[i].Key == key {
			return &w.Series[i]
		}
	}
	if len(w.Series) >= maxSeries {
		return nil
	}
	w.Series = append(w.Series, protocol.ProcessSeries{Key: clip(key, 64), Points: [][2]float64{}})
	return &w.Series[len(w.Series)-1]
}

// widgetReport applies a report's widget parts.
func (p *progress) widgetReport(r report, now time.Time) error {
	if r.Widget != nil {
		if err := p.addWidget(*r.Widget); err != nil {
			return err
		}
	}
	if r.Set != "" {
		if err := p.setWidget(r); err != nil {
			return err
		}
	}
	if r.Plot != "" {
		if r.Y == nil {
			return fmt.Errorf("plot %s: give y", r.Plot)
		}
		if r.Series == "" {
			return fmt.Errorf("plot %s: give a series", r.Plot)
		}
		w, err := p.widgetOf(r.Plot, protocol.WidgetLine)
		if err != nil {
			return err
		}
		s := p.series(w, r.Series)
		if s == nil {
			return fmt.Errorf("widget %s: at most %d series", w.ID, maxSeries)
		}
		var x float64
		switch {
		case r.X != nil:
			x = *r.X
		case w.XLabel == "":
			x = now.Sub(p.started).Seconds()
		case len(s.Points) > 0:
			x = s.Points[len(s.Points)-1][0] + 1
		default:
			x = 1
		}
		addPoint(s, x, *r.Y)
	}
	if r.Bar != "" {
		w, err := p.widgetOf(r.Bar, protocol.WidgetBar)
		if err != nil {
			return err
		}
		if len(w.Stats) > 0 {
			return fmt.Errorf("widget %s shows stats; report those instead", w.ID)
		}
		if r.Label == "" || (r.Value == nil && r.Inc == nil) {
			return fmt.Errorf("bar %s: give a label and a value or inc", w.ID)
		}
		label := clip(r.Label, 60)
		i := 0
		for i < len(w.Bars) && w.Bars[i].Label != label {
			i++
		}
		if i == len(w.Bars) {
			if len(w.Bars) >= maxBars {
				return fmt.Errorf("widget %s: at most %d bars", w.ID, maxBars)
			}
			w.Bars = append(w.Bars, protocol.ProcessBar{Label: label})
		}
		if r.Value != nil {
			w.Bars[i].Value = *r.Value
		} else {
			w.Bars[i].Value += *r.Inc
		}
	}
	if r.Gauge != "" {
		w, err := p.widgetOf(r.Gauge, protocol.WidgetGauge)
		if err != nil {
			return err
		}
		if w.Stat != "" {
			return fmt.Errorf("widget %s shows stat %s; report that instead", w.ID, w.Stat)
		}
		if r.Value == nil {
			return fmt.Errorf("gauge %s: give a value", w.ID)
		}
		v := *r.Value
		w.Value = &v
	}
	if r.Row != "" {
		w, err := p.widgetOf(r.Row, protocol.WidgetTable)
		if err != nil {
			return err
		}
		if len(r.Cells) == 0 {
			return fmt.Errorf("row %s: give its cells, the first one its key", w.ID)
		}
		cells := make([]any, min(len(r.Cells), maxColumns))
		for i := range cells {
			cells[i] = cleanCell(r.Cells[i])
		}
		key := fmt.Sprint(cells[0])
		for i, row := range w.Rows {
			if fmt.Sprint(row[0]) == key {
				w.Rows[i] = cells
				return nil
			}
		}
		w.Rows = append(w.Rows, cells)
		if len(w.Rows) > maxRows {
			w.Rows = append([][]any(nil), w.Rows[len(w.Rows)-maxRows:]...)
		}
	}
	return nil
}

// setWidget replaces a widget's data. A line keeps its series' order (and
// so their colors); new ones are added in name order.
func (p *progress) setWidget(r report) error {
	w := p.widget(r.Set)
	if w == nil {
		return fmt.Errorf("no widget %q; declare it first", r.Set)
	}
	switch w.Kind {
	case protocol.WidgetLine:
		if len(w.Stats) > 0 {
			return fmt.Errorf("widget %s plots stats; report those instead", w.ID)
		}
		if len(r.Points) > maxSeries {
			return fmt.Errorf("widget %s: at most %d series", w.ID, maxSeries)
		}
		var keys []string
		for _, s := range w.Series {
			if _, ok := r.Points[s.Key]; ok {
				keys = append(keys, s.Key)
			}
		}
		var added []string
		for k := range r.Points {
			if !contains(keys, k) {
				added = append(added, k)
			}
		}
		sort.Strings(added)
		w.Series = nil
		for _, k := range append(keys, added...) {
			s := p.series(w, k)
			for _, pt := range r.Points[k] {
				addPoint(s, pt[0], pt[1])
			}
		}
	case protocol.WidgetBar:
		if len(w.Stats) > 0 {
			return fmt.Errorf("widget %s shows stats; report those instead", w.ID)
		}
		w.Bars = w.Bars[:0]
		for _, b := range r.Bars[:min(len(r.Bars), maxBars)] {
			w.Bars = append(w.Bars, protocol.ProcessBar{Label: clip(b.Label, 60), Value: b.Value})
		}
	case protocol.WidgetGauge:
		if w.Stat != "" {
			return fmt.Errorf("widget %s shows stat %s; report that instead", w.ID, w.Stat)
		}
		if r.Value == nil {
			return fmt.Errorf("set %s: give a value", w.ID)
		}
		v := *r.Value
		w.Value = &v
	case protocol.WidgetTable:
		rows := r.Rows[max(0, len(r.Rows)-maxRows):]
		w.Rows = make([][]any, 0, len(rows))
		for _, row := range rows {
			if len(row) == 0 {
				continue
			}
			cells := make([]any, min(len(row), maxColumns))
			for i := range cells {
				cells[i] = cleanCell(row[i])
			}
			w.Rows = append(w.Rows, cells)
		}
	}
	return nil
}

// plotStat adds a stat's new value to the lines that chart it, at most a
// point a second.
func (p *progress) plotStat(s *stat, now time.Time) {
	x := now.Sub(p.started).Seconds()
	for _, w := range p.widgets {
		if w.Kind != protocol.WidgetLine || !contains(w.Stats, s.Key) {
			continue
		}
		ser := p.series(w, s.Key)
		if ser == nil {
			continue
		}
		ser.Label = s.Label
		if n := len(ser.Points); n > 0 && x-ser.Points[n-1][0] < 1 {
			ser.Points[n-1][1] = s.Value
			continue
		}
		addPoint(ser, x, s.Value)
	}
}

// addPoint appends a point, dropping every other older one when the series
// is full so it keeps the whole run's shape.
func addPoint(s *protocol.ProcessSeries, x, y float64) {
	s.Points = append(s.Points, [2]float64{x, y})
	if len(s.Points) <= maxPoints {
		return
	}
	kept := s.Points[:0]
	last := len(s.Points) - 1
	for i, pt := range s.Points {
		if i%2 == 0 || i == last {
			kept = append(kept, pt)
		}
	}
	s.Points = kept
}

// widgetViews copies the widgets, filling in what comes from stats.
func (p *progress) widgetViews() []protocol.ProcessWidget {
	if len(p.widgets) == 0 {
		return nil
	}
	out := make([]protocol.ProcessWidget, len(p.widgets))
	for i, w := range p.widgets {
		v := *w
		v.Series = make([]protocol.ProcessSeries, len(w.Series))
		for j, s := range w.Series {
			s.Points = append([][2]float64{}, s.Points...)
			v.Series[j] = s
		}
		v.Bars = append([]protocol.ProcessBar(nil), w.Bars...)
		v.Rows = append([][]any(nil), w.Rows...)
		switch {
		case w.Kind == protocol.WidgetBar && len(w.Stats) > 0:
			v.Bars = make([]protocol.ProcessBar, 0, len(w.Stats))
			for _, k := range w.Stats {
				b := protocol.ProcessBar{Label: k}
				if s := p.findStat(k); s != nil {
					b.Label, b.Value = statName(s), s.Value
				}
				v.Bars = append(v.Bars, b)
			}
		case w.Kind == protocol.WidgetGauge && w.Stat != "":
			if s := p.findStat(w.Stat); s != nil {
				val := s.Value
				v.Value = &val
				if v.Max == nil {
					v.Max = s.Total
				}
				if v.Unit == "" {
					v.Unit = s.Unit
				}
			}
		}
		out[i] = v
	}
	return out
}

func (p *progress) findStat(key string) *stat {
	for _, s := range p.stats {
		if s.Key == key {
			return s
		}
	}
	return nil
}

// cleanCell keeps a table cell to a string, number or bool.
func cleanCell(c any) any {
	switch v := c.(type) {
	case nil:
		return ""
	case string:
		return clip(v, 200)
	case float64, bool:
		return v
	case json.Number:
		if f, err := v.Float64(); err == nil {
			return f
		}
		return v.String()
	default:
		return clip(fmt.Sprint(v), 200)
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// widgetSummary describes the widgets for the model, briefly.
func widgetSummary(ws []protocol.ProcessWidget) string {
	parts := make([]string, 0, len(ws))
	for _, w := range ws {
		var d string
		switch w.Kind {
		case protocol.WidgetLine:
			ss := make([]string, len(w.Series))
			for i, s := range w.Series {
				ss[i] = fmt.Sprintf("%s %d pts", s.Key, len(s.Points))
			}
			d = strings.Join(ss, ", ")
		case protocol.WidgetBar:
			d = fmt.Sprintf("%d bars", len(w.Bars))
		case protocol.WidgetGauge:
			d = "no value"
			if w.Value != nil {
				d = formatNum(*w.Value)
				if w.Max != nil {
					d += "/" + formatNum(*w.Max)
				}
			}
		case protocol.WidgetTable:
			d = fmt.Sprintf("%d rows", len(w.Rows))
		}
		parts = append(parts, fmt.Sprintf("%s (%s: %s)", w.ID, w.Kind, d))
	}
	return strings.Join(parts, " · ")
}
