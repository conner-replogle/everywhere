package telemetry

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"

	commonv1 "go.opentelemetry.io/proto/otlp/common/v1"
	logsv1 "go.opentelemetry.io/proto/otlp/logs/v1"
	metricsv1 "go.opentelemetry.io/proto/otlp/metrics/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

/*
 * The ingest endpoint, on loopback, for the processes the daemon starts.
 * Each request carries its run's token (X-Everywhere-Token, or Authorization:
 * Bearer), which says where it goes: the project, experiment and run.
 *
 *   POST /log        {"step": 12, "metrics": {"loss": 0.41}, "labels": {...}, "time": ms}  (or a list)
 *   POST /event      {"kind": "sample", "data": {"path": "out/12.png"}, "time": ms}       (or a list)
 *   POST /progress   process_report's fields: stat, value, total, checkpoint, status, notify, widgets…
 *   POST /attach?name=sample.png[&step=12][&caption=…]   the file as the body: an image, a video,
 *                    anything; kept in .everywhere/files and logged as an "attachment" event
 *   POST /v1/metrics OTLP (protobuf or JSON)
 *   POST /v1/logs    OTLP: kept as events of kind "log"
 *   POST /v1/traces  OTLP: accepted and dropped
 */

const (
	maxBody      = 8 << 20
	maxPerPost   = 100_000
	maxEventData = 128 << 10
)

func (h *Hub) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /log", h.handleLog)
	mux.HandleFunc("POST /event", h.handleEvent)
	mux.HandleFunc("POST /progress", h.handleProgress)
	mux.HandleFunc("POST /attach", h.handleAttach)
	mux.HandleFunc("POST /v1/metrics", h.handleOTLPMetrics)
	mux.HandleFunc("POST /v1/logs", h.handleOTLPLogs)
	mux.HandleFunc("POST /v1/traces", func(w http.ResponseWriter, r *http.Request) {
		if h.token(r) == nil {
			http.Error(w, "unknown token", http.StatusUnauthorized)
			return
		}
		otlpOK(w, r)
	})
	return mux
}

func body(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		http.Error(w, err.Error(), http.StatusRequestEntityTooLarge)
		return nil, false
	}
	return b, true
}

// list reads a JSON object, or a list of them.
func list[T any](b []byte) ([]T, error) {
	trimmed := strings.TrimSpace(string(b))
	if strings.HasPrefix(trimmed, "[") {
		var out []T
		err := json.Unmarshal(b, &out)
		return out, err
	}
	var one T
	err := json.Unmarshal(b, &one)
	return []T{one}, err
}

type logEntry struct {
	Step    *float64           `json:"step"`
	Time    int64              `json:"time"`
	Metrics map[string]float64 `json:"metrics"`
	Labels  map[string]string  `json:"labels"`
}

func logPoints(info RunInfo, e logEntry, ts int64) ([]Point, error) {
	if e.Time > 0 {
		ts = e.Time
	}
	labels, err := runLabels(info, e.Labels)
	if err != nil {
		return nil, err
	}
	points := make([]Point, 0, len(e.Metrics))
	for name, v := range e.Metrics {
		if !nameRe.MatchString(name) {
			return nil, fmt.Errorf("metric %q: use letters, digits, _ . : / -", name)
		}
		if math.IsNaN(v) || math.IsInf(v, 0) {
			continue
		}
		points = append(points, Point{Name: name, Labels: labels, TS: ts, Step: e.Step, Value: v})
	}
	return points, nil
}

// runLabels is a point's labels: its own, then the run's, which win.
func runLabels(info RunInfo, own map[string]string) (map[string]string, error) {
	labels := make(map[string]string, len(own)+2)
	for k, v := range own {
		if !keyRe.MatchString(k) {
			return nil, fmt.Errorf("label %q: use letters, digits, ., - and _", k)
		}
		if len(v) > 200 {
			return nil, fmt.Errorf("label %s: over 200 characters", k)
		}
		labels[k] = v
	}
	labels["experiment"], labels["run"] = info.Experiment, info.Run
	return labels, nil
}

func (h *Hub) handleLog(w http.ResponseWriter, r *http.Request) {
	info := h.token(r)
	if info == nil {
		http.Error(w, "unknown token", http.StatusUnauthorized)
		return
	}
	b, ok := body(w, r)
	if !ok {
		return
	}
	entries, err := list[logEntry](b)
	if err != nil {
		http.Error(w, "want {\"step\": 1, \"metrics\": {\"loss\": 0.5}} or a list of them: "+err.Error(), http.StatusBadRequest)
		return
	}
	ts := now()
	var points []Point
	for _, e := range entries {
		ps, err := logPoints(*info, e, ts)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		points = append(points, ps...)
	}
	if len(points) > maxPerPost {
		http.Error(w, fmt.Sprintf("at most %d points a request", maxPerPost), http.StatusRequestEntityTooLarge)
		return
	}
	h.add(info.Home, points, nil)
	w.WriteHeader(http.StatusNoContent)
}

type eventEntry struct {
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data"`
	Time int64           `json:"time"`
}

func (h *Hub) handleEvent(w http.ResponseWriter, r *http.Request) {
	info := h.token(r)
	if info == nil {
		http.Error(w, "unknown token", http.StatusUnauthorized)
		return
	}
	b, ok := body(w, r)
	if !ok {
		return
	}
	entries, err := list[eventEntry](b)
	if err != nil {
		http.Error(w, "want {\"kind\": \"sample\", \"data\": {...}} or a list of them: "+err.Error(), http.StatusBadRequest)
		return
	}
	ts := now()
	events := make([]Event, 0, len(entries))
	for _, e := range entries {
		if !keyRe.MatchString(e.Kind) {
			http.Error(w, fmt.Sprintf("event kind %q: use letters, digits, ., - and _", e.Kind), http.StatusBadRequest)
			return
		}
		if len(e.Data) == 0 {
			e.Data = json.RawMessage("null")
		}
		if len(e.Data) > maxEventData {
			http.Error(w, fmt.Sprintf("an event's data is at most %d KB: write a file and send its path", maxEventData>>10), http.StatusRequestEntityTooLarge)
			return
		}
		at := ts
		if e.Time > 0 {
			at = e.Time
		}
		events = append(events, Event{Experiment: info.Experiment, Run: info.Run, TS: at, Kind: e.Kind, Data: e.Data})
	}
	h.add(info.Home, nil, events)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Hub) handleProgress(w http.ResponseWriter, r *http.Request) {
	info := h.token(r)
	if info == nil {
		http.Error(w, "unknown token", http.StatusUnauthorized)
		return
	}
	b, ok := body(w, r)
	if !ok {
		return
	}
	if h.OnProgress == nil || info.Process == "" {
		http.Error(w, "this run has no process to report progress for", http.StatusNotFound)
		return
	}
	if err := h.OnProgress(info.Process, b); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func isJSON(r *http.Request) bool {
	return strings.HasPrefix(r.Header.Get("Content-Type"), "application/json")
}

func unmarshalOTLP(r *http.Request, b []byte, m proto.Message) error {
	if isJSON(r) {
		return protojson.UnmarshalOptions{DiscardUnknown: true}.Unmarshal(b, m)
	}
	return proto.Unmarshal(b, m)
}

// otlpOK answers an export: an empty Export*ServiceResponse.
func otlpOK(w http.ResponseWriter, r *http.Request) {
	if isJSON(r) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{}"))
		return
	}
	w.Header().Set("Content-Type", "application/x-protobuf")
	w.WriteHeader(http.StatusOK)
}

func attrString(v *commonv1.AnyValue) string {
	switch x := v.GetValue().(type) {
	case *commonv1.AnyValue_StringValue:
		return x.StringValue
	case *commonv1.AnyValue_IntValue:
		return strconv.FormatInt(x.IntValue, 10)
	case *commonv1.AnyValue_DoubleValue:
		return strconv.FormatFloat(x.DoubleValue, 'g', -1, 64)
	case *commonv1.AnyValue_BoolValue:
		return strconv.FormatBool(x.BoolValue)
	default:
		b, _ := protojson.Marshal(v)
		return string(b)
	}
}

func attrLabels(attrs []*commonv1.KeyValue) map[string]string {
	out := map[string]string{}
	for _, kv := range attrs {
		k := strings.ReplaceAll(kv.GetKey(), " ", "_")
		if keyRe.MatchString(k) {
			out[k] = attrString(kv.GetValue())
		}
	}
	return out
}

func nanosToMs(ns uint64, fallback int64) int64 {
	if ns == 0 {
		return fallback
	}
	return int64(ns / 1e6)
}

// handleOTLPMetrics takes an OTLP metrics export. ExportMetricsServiceRequest
// is MetricsData on the wire, so the gRPC service isn't needed. A gauge or
// sum is a point per data point; a histogram or summary becomes <name>.count
// and <name>.sum.
func (h *Hub) handleOTLPMetrics(w http.ResponseWriter, r *http.Request) {
	info := h.token(r)
	if info == nil {
		http.Error(w, "unknown token", http.StatusUnauthorized)
		return
	}
	b, ok := body(w, r)
	if !ok {
		return
	}
	var data metricsv1.MetricsData
	if err := unmarshalOTLP(r, b, &data); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	ts := now()
	var points []Point
	add := func(name string, attrs []*commonv1.KeyValue, t uint64, v float64) {
		name = strings.ReplaceAll(name, " ", "_")
		if !nameRe.MatchString(name) || math.IsNaN(v) || math.IsInf(v, 0) {
			return
		}
		labels, err := runLabels(*info, attrLabels(attrs))
		if err != nil {
			return
		}
		points = append(points, Point{Name: name, Labels: labels, TS: nanosToMs(t, ts), Value: v})
	}
	number := func(dp *metricsv1.NumberDataPoint) float64 {
		switch v := dp.GetValue().(type) {
		case *metricsv1.NumberDataPoint_AsInt:
			return float64(v.AsInt)
		case *metricsv1.NumberDataPoint_AsDouble:
			return v.AsDouble
		}
		return math.NaN()
	}
	for _, rm := range data.GetResourceMetrics() {
		for _, sm := range rm.GetScopeMetrics() {
			for _, m := range sm.GetMetrics() {
				name := m.GetName()
				for _, dp := range m.GetGauge().GetDataPoints() {
					add(name, dp.GetAttributes(), dp.GetTimeUnixNano(), number(dp))
				}
				for _, dp := range m.GetSum().GetDataPoints() {
					add(name, dp.GetAttributes(), dp.GetTimeUnixNano(), number(dp))
				}
				for _, dp := range m.GetHistogram().GetDataPoints() {
					add(name+".count", dp.GetAttributes(), dp.GetTimeUnixNano(), float64(dp.GetCount()))
					add(name+".sum", dp.GetAttributes(), dp.GetTimeUnixNano(), dp.GetSum())
				}
				for _, dp := range m.GetExponentialHistogram().GetDataPoints() {
					add(name+".count", dp.GetAttributes(), dp.GetTimeUnixNano(), float64(dp.GetCount()))
					add(name+".sum", dp.GetAttributes(), dp.GetTimeUnixNano(), dp.GetSum())
				}
				for _, dp := range m.GetSummary().GetDataPoints() {
					add(name+".count", dp.GetAttributes(), dp.GetTimeUnixNano(), float64(dp.GetCount()))
					add(name+".sum", dp.GetAttributes(), dp.GetTimeUnixNano(), dp.GetSum())
				}
			}
		}
	}
	if len(points) > maxPerPost {
		points = points[:maxPerPost]
	}
	h.add(info.Home, points, nil)
	otlpOK(w, r)
}

// handleOTLPLogs keeps OTLP log records as events of kind "log".
func (h *Hub) handleOTLPLogs(w http.ResponseWriter, r *http.Request) {
	info := h.token(r)
	if info == nil {
		http.Error(w, "unknown token", http.StatusUnauthorized)
		return
	}
	b, ok := body(w, r)
	if !ok {
		return
	}
	var data logsv1.LogsData
	if err := unmarshalOTLP(r, b, &data); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	ts := now()
	var events []Event
	for _, rl := range data.GetResourceLogs() {
		for _, sl := range rl.GetScopeLogs() {
			for _, lr := range sl.GetLogRecords() {
				d, _ := json.Marshal(map[string]any{
					"body":       attrString(lr.GetBody()),
					"severity":   lr.GetSeverityText(),
					"attributes": attrLabels(lr.GetAttributes()),
				})
				if len(d) > maxEventData {
					continue
				}
				events = append(events, Event{Experiment: info.Experiment, Run: info.Run, TS: nanosToMs(lr.GetTimeUnixNano(), ts), Kind: "log", Data: d})
			}
		}
	}
	h.add(info.Home, nil, events)
	otlpOK(w, r)
}
