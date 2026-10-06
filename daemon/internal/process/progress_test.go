package process

import (
	"strings"
	"testing"
	"time"
)

func f(v float64) *float64 { return &v }

func TestParseReport(t *testing.T) {
	r, err := parseReport(`stat migrated 120/4000 "Users migrated"`)
	if err != nil || r.Stat != "migrated" || *r.Value != 120 || *r.Total != 4000 || r.Label != "Users migrated" {
		t.Fatalf("counter: %+v %v", r, err)
	}
	r, err = parseReport(`stat migrated +1`)
	if err != nil || r.Inc == nil || *r.Inc != 1 || r.Value != nil {
		t.Fatalf("increment: %+v %v", r, err)
	}
	r, err = parseReport(`stat rate 41.5 /s`)
	if err != nil || *r.Value != 41.5 || r.Unit != "/s" {
		t.Fatalf("unit: %+v %v", r, err)
	}
	r, err = parseReport(`checkpoint "Schema migrated"`)
	if err != nil || r.Checkpoint != "Schema migrated" {
		t.Fatalf("checkpoint: %+v %v", r, err)
	}
	r, err = parseReport(`status Backfilling orders`)
	if err != nil || *r.Status != "Backfilling orders" {
		t.Fatalf("status: %+v %v", r, err)
	}
	r, err = parseReport(`{"stat":"done","value":3,"total":9}`)
	if err != nil || r.Stat != "done" || *r.Value != 3 || *r.Total != 9 {
		t.Fatalf("json: %+v %v", r, err)
	}
	if _, err := parseReport("bogus x"); err == nil {
		t.Fatal("unknown verb parsed")
	}
}

func TestProgressCheckpointsAndStats(t *testing.T) {
	t0 := time.Unix(1000, 0)
	p, err := newProgress(t0,
		[]CheckpointSpec{{Label: "Compiled", Pattern: `compiled \w+`}, {Label: "Tests pass", Notify: true}},
		[]StatSpec{{Key: "errors", NotifyWhen: "> 0"}},
		map[string]int64{"Compiled": 2500})
	if err != nil {
		t.Fatal(err)
	}
	if p.checkpoints[0].PrevMs == nil || *p.checkpoints[0].PrevMs != 2500 {
		t.Fatal("previous timing not carried over")
	}
	if evs := p.line("webpack compiled successfully", 10, t0.Add(3*time.Second)); len(evs) != 0 {
		t.Fatalf("Compiled doesn't notify: %v", evs)
	}
	if p.checkpoints[0].ReachedAt == nil || p.checkpoints[0].Offset != 10 {
		t.Fatal("pattern checkpoint not reached")
	}
	evs := p.line(`::ew checkpoint "Tests pass"`, 20, t0.Add(41*time.Second))
	if len(evs) != 1 || !strings.Contains(evs[0].text, "41s") {
		t.Fatalf("Tests pass should notify: %v", evs)
	}
	// Reaching it again says nothing.
	if evs := p.line(`::ew checkpoint "Tests pass"`, 30, t0.Add(42*time.Second)); len(evs) != 0 {
		t.Fatalf("second reach notified: %v", evs)
	}
	p.line(`::ew checkpoint "Extra"`, 40, t0.Add(43*time.Second))
	if len(p.checkpoints) != 3 || p.checkpoints[2].ReachedAt == nil {
		t.Fatal("reported checkpoint not added")
	}

	if evs := p.line("::ew stat errors 0", 0, t0); len(evs) != 0 {
		t.Fatal("notify_when fired at 0")
	}
	if evs := p.line("::ew stat errors +2", 0, t0); len(evs) != 1 {
		t.Fatalf("notify_when didn't fire: %v", evs)
	}
	if evs := p.line("::ew stat errors +1", 0, t0); len(evs) != 0 {
		t.Fatal("notify_when fired again while still met")
	}
	if p.lastLine != "webpack compiled successfully" {
		t.Fatalf("report lines count as the last line: %q", p.lastLine)
	}
}

func TestStatRate(t *testing.T) {
	t0 := time.Unix(1000, 0)
	p, _ := newProgress(t0, nil, nil, nil)
	for i := 0; i <= 20; i++ {
		p.apply(report{Stat: "rows", Value: f(float64(i * 10)), Total: f(400)}, 0, t0.Add(time.Duration(i)*time.Second))
	}
	v := p.stats[0].view(t0.Add(20 * time.Second))
	if v.Rate == nil || *v.Rate != 10 {
		t.Fatalf("rate %v, want 10", v.Rate)
	}
	if v.ETA == nil || *v.ETA != 20 {
		t.Fatalf("eta %v, want 20", v.ETA)
	}
	// Stalled for 20s: the rate falls off.
	if v := p.stats[0].view(t0.Add(40 * time.Second)); *v.Rate >= 10 {
		t.Fatalf("stalled rate %v didn't fall", *v.Rate)
	}
}

func TestOSCProgress(t *testing.T) {
	p, _ := newProgress(time.Now(), nil, nil, nil)
	p.oscPayload("9;4;1;42")
	if p.osc == nil || p.osc.Percent != 42 || p.osc.State != "normal" {
		t.Fatalf("got %+v", p.osc)
	}
	p.oscPayload("9;4;0")
	if p.osc != nil {
		t.Fatal("not cleared")
	}
}
