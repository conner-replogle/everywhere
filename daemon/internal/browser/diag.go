package browser

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	diagKeep     = 200  // entries of each kind
	diagTextMax  = 2000 // bytes per console message
	maxInFlight  = 2000 // requests remembered for their URL and method
	actionErrMax = 300
)

// ConsoleEntry is something the page logged, or an uncaught exception.
type ConsoleEntry struct {
	Level  string    `json:"level"` // log | info | warning | error | debug ...
	Text   string    `json:"text"`
	Source string    `json:"source,omitempty"` // url:line
	At     time.Time `json:"at"`
}

// NetworkEntry is a request that failed or got an error status.
type NetworkEntry struct {
	URL       string    `json:"url"`
	Method    string    `json:"method,omitempty"`
	Status    int       `json:"status,omitempty"`
	ErrorText string    `json:"errorText,omitempty"`
	Type      string    `json:"type,omitempty"` // Document, XHR, Fetch, Script, ...
	At        time.Time `json:"at"`
}

// ActionEntry is one thing an agent did in the tab.
type ActionEntry struct {
	Action string    `json:"action"`
	Detail string    `json:"detail,omitempty"`
	Error  string    `json:"error,omitempty"`
	At     time.Time `json:"at"`
}

// diagnostics collects what a page logged and which requests failed, for
// agents inspecting the page.
type diagnostics struct {
	mu       sync.Mutex
	console  ring[ConsoleEntry]
	network  ring[NetworkEntry]
	actions  ring[ActionEntry]
	inFlight map[string]request // by request id; only touched by note
}

type request struct{ url, method string }

// note sees every CDP event of the tab, on its event goroutine.
func (d *diagnostics) note(method string, params json.RawMessage) {
	switch method {
	case "Runtime.consoleAPICalled":
		var p struct {
			Type       string         `json:"type"`
			Args       []remoteObject `json:"args"`
			Timestamp  float64        `json:"timestamp"`
			StackTrace *stackTrace    `json:"stackTrace"`
		}
		if json.Unmarshal(params, &p) != nil {
			return
		}
		parts := make([]string, 0, len(p.Args))
		for _, a := range p.Args {
			parts = append(parts, a.String())
		}
		level := p.Type
		switch level {
		case "warning", "assert":
			level = "warning"
		case "trace", "dir", "dirxml", "table", "count", "timeEnd", "startGroup", "startGroupCollapsed", "endGroup", "clear", "profile", "profileEnd":
			level = "log"
		}
		d.addConsole(ConsoleEntry{Level: level, Text: strings.Join(parts, " "), Source: p.StackTrace.source(), At: epochMillis(p.Timestamp)})
	case "Runtime.exceptionThrown":
		var p struct {
			Timestamp float64 `json:"timestamp"`
			Details   struct {
				Text       string        `json:"text"`
				URL        string        `json:"url"`
				LineNumber int           `json:"lineNumber"`
				Exception  *remoteObject `json:"exception"`
				StackTrace *stackTrace   `json:"stackTrace"`
			} `json:"exceptionDetails"`
		}
		if json.Unmarshal(params, &p) != nil {
			return
		}
		e := p.Details
		text := e.Text
		if e.Exception != nil {
			if s := e.Exception.String(); s != "" {
				text = s
			}
		}
		src := e.StackTrace.source()
		if src == "" && e.URL != "" {
			src = fmt.Sprintf("%s:%d", e.URL, e.LineNumber+1)
		}
		d.addConsole(ConsoleEntry{Level: "error", Text: text, Source: src, At: epochMillis(p.Timestamp)})
	case "Log.entryAdded":
		var p struct {
			Entry struct {
				Level      string  `json:"level"` // verbose | info | warning | error
				Text       string  `json:"text"`
				URL        string  `json:"url"`
				LineNumber int     `json:"lineNumber"`
				Timestamp  float64 `json:"timestamp"`
			} `json:"entry"`
		}
		if json.Unmarshal(params, &p) != nil {
			return
		}
		e := p.Entry
		src := e.URL
		if src != "" && e.LineNumber > 0 {
			src = fmt.Sprintf("%s:%d", src, e.LineNumber+1)
		}
		level := e.Level
		if level == "verbose" {
			level = "debug"
		}
		d.addConsole(ConsoleEntry{Level: level, Text: e.Text, Source: src, At: epochMillis(e.Timestamp)})
	case "Network.requestWillBeSent":
		var p struct {
			RequestID string `json:"requestId"`
			Request   struct {
				URL    string `json:"url"`
				Method string `json:"method"`
			} `json:"request"`
		}
		if json.Unmarshal(params, &p) != nil {
			return
		}
		d.mu.Lock()
		if d.inFlight == nil || len(d.inFlight) >= maxInFlight {
			d.inFlight = map[string]request{} // requests that never finished; forget them
		}
		d.inFlight[p.RequestID] = request{p.Request.URL, p.Request.Method}
		d.mu.Unlock()
	case "Network.responseReceived":
		var p struct {
			RequestID string `json:"requestId"`
			Type      string `json:"type"`
			Response  struct {
				URL        string `json:"url"`
				Status     int    `json:"status"`
				StatusText string `json:"statusText"`
			} `json:"response"`
		}
		if json.Unmarshal(params, &p) != nil || p.Response.Status < 400 {
			return
		}
		d.mu.Lock()
		req := d.inFlight[p.RequestID]
		d.network.add(NetworkEntry{URL: p.Response.URL, Method: req.method, Status: p.Response.Status, ErrorText: p.Response.StatusText, Type: p.Type, At: time.Now()})
		d.mu.Unlock()
	case "Network.loadingFinished":
		var p struct {
			RequestID string `json:"requestId"`
		}
		if json.Unmarshal(params, &p) == nil {
			d.mu.Lock()
			delete(d.inFlight, p.RequestID)
			d.mu.Unlock()
		}
	case "Network.loadingFailed":
		var p struct {
			RequestID string `json:"requestId"`
			Type      string `json:"type"`
			ErrorText string `json:"errorText"`
			Canceled  bool   `json:"canceled"`
		}
		if json.Unmarshal(params, &p) != nil {
			return
		}
		d.mu.Lock()
		req, ok := d.inFlight[p.RequestID]
		delete(d.inFlight, p.RequestID)
		// Canceled requests are the page (or a navigation) changing its mind,
		// not failures.
		if ok && !p.Canceled {
			d.network.add(NetworkEntry{URL: req.url, Method: req.method, ErrorText: p.ErrorText, Type: p.Type, At: time.Now()})
		}
		d.mu.Unlock()
	}
}

func (d *diagnostics) addConsole(e ConsoleEntry) {
	e.Text = clipText(e.Text, diagTextMax)
	d.mu.Lock()
	d.console.add(e)
	d.mu.Unlock()
}

// act records an agent action; err may be nil.
func (d *diagnostics) act(action, detail string, err error) {
	e := ActionEntry{Action: action, Detail: clipText(detail, 200), At: time.Now()}
	if err != nil {
		e.Error = clipText(err.Error(), actionErrMax)
	}
	d.mu.Lock()
	d.actions.add(e)
	d.mu.Unlock()
}

// Diagnostics returns up to the last n console messages, failed requests and
// agent actions, oldest first.
func (t *Tab) Diagnostics(n int) (console []ConsoleEntry, network []NetworkEntry, actions []ActionEntry) {
	d := &t.diag
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.console.last(n), d.network.last(n), d.actions.last(n)
}

// ring keeps the newest diagKeep items.
type ring[T any] struct {
	items []T
	next  int // the oldest item, once full
}

func (r *ring[T]) add(v T) {
	if len(r.items) < diagKeep {
		r.items = append(r.items, v)
		return
	}
	r.items[r.next] = v
	r.next = (r.next + 1) % diagKeep
}

// last returns up to n newest items, oldest first.
func (r *ring[T]) last(n int) []T {
	all := make([]T, 0, len(r.items))
	all = append(all, r.items[r.next:]...)
	all = append(all, r.items[:r.next]...)
	if n >= 0 && len(all) > n {
		all = all[len(all)-n:]
	}
	return all
}

type remoteObject struct {
	Type                string          `json:"type"`
	Subtype             string          `json:"subtype"`
	Value               json.RawMessage `json:"value"`
	UnserializableValue string          `json:"unserializableValue"`
	Description         string          `json:"description"`
}

func (o remoteObject) String() string {
	switch {
	case o.UnserializableValue != "":
		return o.UnserializableValue
	case o.Type == "string":
		var s string
		if json.Unmarshal(o.Value, &s) == nil {
			return s
		}
	case o.Type == "undefined":
		return "undefined"
	case o.Description != "":
		return o.Description
	case len(o.Value) > 0:
		return string(o.Value)
	}
	return o.Type
}

type stackTrace struct {
	CallFrames []struct {
		URL        string `json:"url"`
		LineNumber int    `json:"lineNumber"`
	} `json:"callFrames"`
}

func (s *stackTrace) source() string {
	if s == nil {
		return ""
	}
	for _, f := range s.CallFrames {
		if f.URL != "" {
			return fmt.Sprintf("%s:%d", f.URL, f.LineNumber+1)
		}
	}
	return ""
}

// epochMillis converts a CDP Runtime timestamp (ms since the epoch); Log
// and Runtime use milliseconds, unlike Network's seconds since start.
func epochMillis(ms float64) time.Time {
	if ms <= 0 {
		return time.Now()
	}
	return time.UnixMilli(int64(ms))
}

func clipText(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8Start(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}

func utf8Start(b byte) bool { return b&0xC0 != 0x80 }
