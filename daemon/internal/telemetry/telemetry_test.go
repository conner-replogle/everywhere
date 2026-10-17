package telemetry

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	commonv1 "go.opentelemetry.io/proto/otlp/common/v1"
	metricsv1 "go.opentelemetry.io/proto/otlp/metrics/v1"
	"google.golang.org/protobuf/proto"
)

func post(t *testing.T, h *Hub, tok, path, ctype string, body []byte) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", h.Addr()+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", ctype)
	if tok != "" {
		req.Header.Set("X-Everywhere-Token", tok)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func TestTelemetry(t *testing.T) {
	home := t.TempDir()
	h := New()
	var changes []map[string][]string
	h.OnChange = func(_ string, c map[string][]string) { changes = append(changes, c) }
	var progress []string
	h.OnProgress = func(id string, r json.RawMessage) error { progress = append(progress, id+":"+string(r)); return nil }
	if err := h.Start(); err != nil {
		t.Fatal(err)
	}
	defer h.Close()

	r1, err := h.StartRun(home, "train", "", "p1")
	if err != nil || r1.Run != "train#1" {
		t.Fatalf("run %+v %v", r1, err)
	}
	r2, _ := h.StartRun(home, "train", "", "p2")
	if r2.Run != "train#2" {
		t.Fatalf("second run %q", r2.Run)
	}
	if code, _ := post(t, h, "nope", "/log", "application/json", []byte(`{"metrics":{"x":1}}`)); code != 401 {
		t.Fatalf("bad token: %d", code)
	}

	// /log, as a list, with steps.
	var b strings.Builder
	b.WriteString("[")
	for i := 0; i < 1000; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `{"step":%d,"metrics":{"loss":%g,"acc":0.5}}`, i, 2-float64(i)/1000)
	}
	b.WriteString("]")
	if code, msg := post(t, h, r1.Token, "/log", "application/json", []byte(b.String())); code != 204 {
		t.Fatalf("log: %d %s", code, msg)
	}
	if code, msg := post(t, h, r2.Token, "/log", "application/json", []byte(`{"step":0,"metrics":{"loss":3}}`)); code != 204 {
		t.Fatalf("log 2: %d %s", code, msg)
	}
	// A name it can't take is cleaned, not the request refused.
	if code, msg := post(t, h, r1.Token, "/log", "application/json", []byte(`{"metrics":{"seen by 2+":1},"labels":{"a b":"x"}}`)); code != 204 {
		t.Fatalf("odd name: %d %s", code, msg)
	}

	// A run that never reports leaves nothing, and doesn't take a name twice.
	idle, _ := h.StartRun(home, "train", "", "p3")
	idle2, _ := h.StartRun(home, "train", "", "p4")
	if idle.Run != "train#3" || idle2.Run != "train#4" {
		t.Fatalf("idle runs %q %q", idle.Run, idle2.Run)
	}
	h.EndRun(idle, "exited")

	// OTLP, protobuf: a gauge with an attribute.
	md := &metricsv1.MetricsData{ResourceMetrics: []*metricsv1.ResourceMetrics{{ScopeMetrics: []*metricsv1.ScopeMetrics{{Metrics: []*metricsv1.Metric{{
		Name: "gpu.util",
		Data: &metricsv1.Metric_Gauge{Gauge: &metricsv1.Gauge{DataPoints: []*metricsv1.NumberDataPoint{{
			Attributes: []*commonv1.KeyValue{{Key: "gpu", Value: &commonv1.AnyValue{Value: &commonv1.AnyValue_IntValue{IntValue: 0}}}},
			Value:      &metricsv1.NumberDataPoint_AsDouble{AsDouble: 87},
		}}}},
	}}}}}}}
	pb, _ := proto.Marshal(md)
	if code, msg := post(t, h, r1.Token, "/v1/metrics", "application/x-protobuf", pb); code != 200 {
		t.Fatalf("otlp: %d %s", code, msg)
	}
	// Events, attachments, progress.
	if code, _ := post(t, h, r1.Token, "/event", "application/json", []byte(`{"kind":"checkpoint","data":"epoch 1"}`)); code != 204 {
		t.Fatal("event")
	}
	code, msg := post(t, h, r1.Token, "/attach?name=sample.png&step=12", "image/png", []byte("\x89PNG fake"))
	if code != 200 || !strings.Contains(msg, ".everywhere/files/train/train_1/") {
		t.Fatalf("attach: %d %s", code, msg)
	}
	if code, _ := post(t, h, r1.Token, "/progress", "application/json", []byte(`{"status":"go"}`)); code != 204 || len(progress) != 1 || progress[0] != `p1:{"status":"go"}` {
		t.Fatalf("progress: %v", progress)
	}

	// Queries see it all (they write what's pending first).
	cat, err := h.Catalog(home, "train")
	if err != nil || len(cat.Runs) != 2 || len(cat.Metrics) != 4 {
		t.Fatalf("catalog %+v %v", cat, err)
	}
	if !hasMetric(cat, "seen_by_2_") {
		t.Fatalf("cleaned name missing: %+v", cat.Metrics)
	}
	for _, m := range cat.Metrics {
		if m.Name == "loss" && (!m.Steps || len(m.Labels["run"]) != 2) {
			t.Fatalf("loss info %+v", m)
		}
		if m.Name == "gpu.util" && (m.Steps || m.Labels["gpu"][0] != "0") {
			t.Fatalf("gpu info %+v", m)
		}
	}
	res, err := h.Query(home, Query{Metric: "loss", Points: 100})
	if err != nil || res.X != "step" || len(res.Series) != 2 {
		t.Fatalf("query %+v %v", res, err)
	}
	s1 := res.Series[0]
	if s1.Labels["run"] != "train#1" || len(s1.Points) > 101 || len(s1.Points) < 90 || s1.Points[0][1] > 2 || s1.Min[0] > s1.Points[0][1] {
		t.Fatalf("buckets: %d points, first %v", len(s1.Points), s1.Points[0])
	}
	from, to := 500.0, 599.0
	zoom, _ := h.Query(home, Query{Metric: "loss", Where: map[string][]string{"run": {"train#1"}}, From: &from, To: &to, Points: 1000})
	if len(zoom.Series) != 1 || len(zoom.Series[0].Points) != 100 || zoom.Series[0].Points[0][0] != 500 {
		t.Fatalf("zoomed in: %d points from %v", len(zoom.Series[0].Points), zoom.Series[0].Points[0])
	}
	evs, _ := h.Events(home, "train", nil, "", 0, 10)
	if len(evs) != 2 || evs[0].Kind != "attachment" {
		t.Fatalf("events %+v", evs)
	}
	var a Attachment
	_ = json.Unmarshal(evs[0].Data, &a)
	if p, fi, err := File(home, a.Path); err != nil || fi.Size() != 9 || !strings.HasPrefix(p, home) || a.Type != "image/png" || *a.Step != 12 {
		t.Fatalf("attachment %+v: %v", a, err)
	}
	if _, _, err := File(home, "../x"); err == nil {
		t.Fatal("read outside the project")
	}
	if len(changes) == 0 {
		t.Fatal("no change told")
	}

	// It all lives in the project, and outlives the hub.
	h.EndRun(r1, "exited")
	h.Close()
	if _, err := os.Stat(filepath.Join(home, DBFile)); err != nil {
		t.Fatal(err)
	}
	h2 := New()
	defer h2.Close()
	cat, _ = h2.Catalog(home, "train")
	if len(cat.Runs) != 2 || cat.Runs[0].Status != "exited" || cat.Runs[0].EndedAt == nil {
		t.Fatalf("reopened %+v", cat.Runs)
	}
	if err := h2.SetDashboardState(home, "train", "tab", json.RawMessage(`"loss"`)); err != nil {
		t.Fatal(err)
	}
	if st, _ := h2.DashboardState(home, "train"); string(st["tab"]) != `"loss"` {
		t.Fatalf("state %v", st)
	}
	if b, _ := os.ReadFile(filepath.Join(home, ".everywhere", ".gitignore")); !strings.Contains(string(b), "telemetry.db") {
		t.Fatalf("gitignore %q", b)
	}
}

func hasMetric(c Catalog, name string) bool {
	for _, m := range c.Metrics {
		if m.Name == name {
			return true
		}
	}
	return false
}
