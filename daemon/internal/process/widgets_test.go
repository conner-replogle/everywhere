package process

import (
	"testing"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

func TestWidgets(t *testing.T) {
	t0 := time.Unix(1000, 0)
	p, _ := newProgress(t0, nil, []StatSpec{{Key: "rows", Total: f(100)}}, nil)
	for _, w := range []WidgetSpec{
		{ID: "loss", Kind: "line", XLabel: "epoch"},
		{ID: "speed", Kind: "line", Stats: []string{"rows"}},
		{ID: "fails", Kind: "bar"},
		{ID: "done", Kind: "gauge", Stat: "rows"},
		{ID: "runs", Kind: "table", Columns: []string{"run", "score"}},
	} {
		if err := p.addWidget(w); err != nil {
			t.Fatal(err)
		}
	}
	if err := p.addWidget(WidgetSpec{ID: "g", Kind: "gauge"}); err == nil {
		t.Fatal("gauge with no max or stat")
	}
	if err := p.addWidget(WidgetSpec{ID: "x", Kind: "pie"}); err == nil {
		t.Fatal("unknown kind")
	}

	reports := []report{
		{Plot: "loss", Series: "train", Y: f(0.9)},
		{Plot: "loss", Series: "train", Y: f(0.5)},
		{Plot: "loss", Series: "val", X: f(7), Y: f(0.6)},
		{Bar: "fails", Label: "a.go", Inc: f(1)},
		{Bar: "fails", Label: "a.go", Inc: f(1)},
		{Bar: "fails", Label: "b.go", Value: f(5)},
		{Row: "runs", Cells: []any{"r1", 0.5}},
		{Row: "runs", Cells: []any{"r2", 0.7}},
		{Row: "runs", Cells: []any{"r1", 0.8}},
		{Plot: "nope", Series: "s", Y: f(1)}, // no such widget: ignored
	}
	for _, r := range reports {
		p.apply(r, 0, t0)
	}
	for i := 0; i <= 3; i++ {
		p.apply(report{Stat: "rows", Value: f(float64(i * 10))}, 0, t0.Add(time.Duration(i)*time.Second))
	}

	ws := map[string]protocol.ProcessWidget{}
	for _, w := range p.widgetViews() {
		ws[w.ID] = w
	}
	if s := ws["loss"].Series; len(s) != 2 || s[0].Points[1] != [2]float64{2, 0.5} || s[1].Points[0] != [2]float64{7, 0.6} {
		t.Fatalf("loss: %+v", s)
	}
	if s := ws["speed"].Series; len(s) != 1 || len(s[0].Points) != 4 || s[0].Points[3] != [2]float64{3, 30} {
		t.Fatalf("stat line: %+v", s)
	}
	if b := ws["fails"].Bars; len(b) != 2 || b[0].Value != 2 || b[1].Value != 5 {
		t.Fatalf("bars: %+v", b)
	}
	if g := ws["done"]; g.Value == nil || *g.Value != 30 || g.Max == nil || *g.Max != 100 {
		t.Fatalf("gauge: %+v", g)
	}
	if r := ws["runs"].Rows; len(r) != 2 || r[0][1] != 0.8 {
		t.Fatalf("rows: %+v", r)
	}

	// The model hears about mistakes.
	if err := p.widgetReport(report{Gauge: "done", Value: f(1)}, t0); err == nil {
		t.Fatal("set a stat-bound gauge")
	}
	if err := p.widgetReport(report{Bar: "loss", Label: "x", Value: f(1)}, t0); err == nil {
		t.Fatal("bar on a line widget")
	}

	// Redeclaring keeps the data; changing kind drops it.
	_ = p.addWidget(WidgetSpec{ID: "fails", Kind: "bar", Title: "Failures"})
	if w := p.widget("fails"); w.Title != "Failures" || len(w.Bars) != 2 {
		t.Fatalf("redeclared: %+v", w)
	}
	_ = p.addWidget(WidgetSpec{ID: "fails", Kind: "gauge", Max: f(10)})
	if w := p.widget("fails"); len(w.Bars) != 0 || w.Title != "" {
		t.Fatalf("changed kind: %+v", w)
	}
}

func TestPointsThinOut(t *testing.T) {
	s := &protocol.ProcessSeries{}
	for i := 0; i < 1000; i++ {
		addPoint(s, float64(i), float64(i))
	}
	if len(s.Points) > maxPoints || s.Points[0][0] != 0 || s.Points[len(s.Points)-1][0] != 999 {
		t.Fatalf("%d points, %v … %v", len(s.Points), s.Points[0], s.Points[len(s.Points)-1])
	}
}

func TestSetWidget(t *testing.T) {
	t0 := time.Unix(1000, 0)
	p, _ := newProgress(t0, nil, nil, nil)
	for _, w := range []WidgetSpec{
		{ID: "loss", Kind: "line", XLabel: "epoch"},
		{ID: "fails", Kind: "bar"},
		{ID: "runs", Kind: "table", Columns: []string{"run", "score"}},
	} {
		_ = p.addWidget(w)
	}
	p.apply(report{Plot: "loss", Series: "val", X: f(1), Y: f(2)}, 0, t0)
	p.apply(report{Set: "loss", Points: map[string][][2]float64{"train": {{1, 0.9}, {2, 0.6}}, "val": {{1, 1.1}}, "aux": {{1, 5}}}}, 0, t0)
	w := p.widget("loss")
	if len(w.Series) != 3 || w.Series[0].Key != "val" || w.Series[1].Key != "aux" || w.Series[2].Key != "train" || len(w.Series[2].Points) != 2 {
		t.Fatalf("line kept its series' order, then added by name: %+v", w.Series)
	}
	p.apply(report{Set: "fails", Bars: []protocol.ProcessBar{{Label: "api", Value: 3}}}, 0, t0)
	p.apply(report{Set: "runs", Rows: [][]any{{"a", 1.0}, {"b", 2.0}}}, 0, t0)
	if len(p.widget("fails").Bars) != 1 || len(p.widget("runs").Rows) != 2 {
		t.Fatalf("bars %+v rows %+v", p.widget("fails").Bars, p.widget("runs").Rows)
	}
}
