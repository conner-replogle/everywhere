// Command opencode is an everywhere plugin for OpenCode threads, like
// Claude threads: a conversation with OpenCode in the thread's directory,
// with its tool calls, permission prompts and questions, from any device.
//
// It runs one `opencode serve` on loopback (with a password of its own)
// for every thread, each thread being an OpenCode session in its project's
// directory, and forwards the server's events to the thread's view.
//
// Install it on a device that has opencode (it builds there):
//
//	go build -o opencode-plugin . && everywhere plugin install .
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/conner-replogle/everywhere/daemon/sdk/plugin"
)

func main() {
	p := plugin.New()
	oc := &opencode{p: p, kv: p.KV(), bySession: map[string]*record{}, busy: map[string]bool{}, waiting: map[string]map[string]bool{}}
	oc.register()
	go oc.events()
	err := p.Run()
	oc.stop()
	if err != nil {
		log.Fatal(err)
	}
}

// record is what a pane (an OpenCode thread, or an OpenCode tab in another
// thread) is: its session, kept in the plugin's state for the pane.
type record struct {
	Pane      string `json:"pane"`
	Thread    string `json:"threadId"`
	Session   string `json:"session"`
	Directory string `json:"directory"`
}

type opencode struct {
	p  *plugin.Plugin
	kv plugin.KV

	srvMu    sync.Mutex
	base     string
	password string
	cmd      *exec.Cmd
	exited   chan struct{}

	mu        sync.Mutex
	loaded    bool
	bySession map[string]*record
	// busy sessions, and the permissions and questions each waits on.
	busy    map[string]bool
	waiting map[string]map[string]bool
}

// --- the server ---------------------------------------------------------------

// server starts `opencode serve` if it isn't running, and gives its address.
func (o *opencode) server() (string, error) {
	o.srvMu.Lock()
	defer o.srvMu.Unlock()
	if o.cmd != nil {
		select {
		case <-o.exited:
			o.cmd = nil
		default:
			return o.base, nil
		}
	}
	bin := "opencode"
	o.p.Setting("command", &bin)
	if strings.TrimSpace(bin) == "" {
		bin = "opencode"
	}
	port, err := freePort()
	if err != nil {
		return "", err
	}
	pw := make([]byte, 24)
	_, _ = rand.Read(pw)
	o.password = hex.EncodeToString(pw)
	cmd := exec.Command(bin, "serve", "--hostname", "127.0.0.1", "--port", fmt.Sprint(port))
	cmd.Env = append(os.Environ(), "OPENCODE_SERVER_PASSWORD="+o.password)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("starting %s: %w (is OpenCode installed? Settings → Plugins → OpenCode names the command)", bin, err)
	}
	listening := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(out)
		for sc.Scan() {
			line := sc.Text()
			if _, addr, ok := strings.Cut(line, "listening on "); ok {
				select {
				case listening <- strings.TrimSpace(addr):
				default:
				}
			}
			fmt.Fprintln(os.Stderr, "opencode:", line)
		}
	}()
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	select {
	case addr := <-listening:
		o.base, o.cmd, o.exited = addr, cmd, exited
		o.p.Log("info", "opencode serve is up at %s", addr)
		return addr, nil
	case <-exited:
		return "", errors.New("opencode serve exited before it was ready (see the daemon's log)")
	case <-time.After(30 * time.Second):
		_ = cmd.Process.Kill()
		return "", errors.New("opencode serve didn't start in 30s")
	}
}

func (o *opencode) stop() {
	o.srvMu.Lock()
	defer o.srvMu.Unlock()
	if o.cmd != nil {
		_ = o.cmd.Process.Signal(os.Interrupt)
		select {
		case <-o.exited:
		case <-time.After(3 * time.Second):
			_ = o.cmd.Process.Kill()
		}
	}
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// api calls the server: path with the directory's instance (if any), body
// as JSON, the answer decoded into out (if not nil).
func (o *opencode) api(ctx context.Context, method, path, directory string, body, out any) error {
	base, err := o.server()
	if err != nil {
		return err
	}
	u := base + path
	if directory != "" {
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		u += sep + "directory=" + url.QueryEscape(directory)
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	req.SetBasicAuth("opencode", o.password)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if res.StatusCode >= 300 {
		return fmt.Errorf("opencode: %s %s: %s %s", method, path, res.Status, strings.TrimSpace(string(firstLine(b))))
	}
	if out == nil || len(b) == 0 {
		return nil
	}
	return json.Unmarshal(b, out)
}

func firstLine(b []byte) []byte {
	if len(b) > 300 {
		b = b[:300]
	}
	line, _, _ := bytes.Cut(b, []byte("\n"))
	return line
}

// --- panes and their sessions ---------------------------------------------------

func scope(pane string) string { return "thread:" + pane }

// load reads every pane's record once, to know whose events are whose.
func (o *opencode) load() {
	o.mu.Lock()
	if o.loaded {
		o.mu.Unlock()
		return
	}
	o.mu.Unlock()
	scopes, err := o.kv.Scopes("thread:")
	if err != nil {
		return
	}
	recs := map[string]*record{}
	for _, sc := range scopes {
		var r record
		if ok, _ := o.kv.Get(sc, "session", &r); ok && r.Session != "" {
			recs[r.Session] = &r
		}
	}
	o.mu.Lock()
	for k, v := range recs {
		o.bySession[k] = v
	}
	o.loaded = true
	o.mu.Unlock()
}

// session gives a pane's session, starting one in its directory the first time.
func (o *opencode) session(ctx context.Context, pane, thread string) (*record, error) {
	if pane == "" {
		return nil, errors.New("which pane?")
	}
	o.load()
	var r record
	if ok, err := o.kv.Get(scope(pane), "session", &r); err != nil {
		return nil, err
	} else if ok && r.Session != "" {
		return &r, nil
	}
	dir, err := o.p.Workdir(pane)
	if err != nil {
		return nil, err
	}
	var s struct {
		ID string `json:"id"`
	}
	if err := o.api(ctx, "POST", "/session", dir, map[string]any{}, &s); err != nil {
		return nil, err
	}
	if thread == "" {
		thread = pane
	}
	r = record{Pane: pane, Thread: thread, Session: s.ID, Directory: dir}
	if err := o.kv.Set(scope(pane), "session", r); err != nil {
		return nil, err
	}
	o.mu.Lock()
	o.bySession[r.Session] = &r
	o.mu.Unlock()
	return &r, nil
}

// paneArgs are what every method of a pane gets.
type paneArgs struct {
	Pane     string `json:"pane"`
	ThreadID string `json:"threadId"`
}

func (a paneArgs) pane() string {
	if a.Pane != "" {
		return a.Pane
	}
	return a.ThreadID
}

func (o *opencode) register() {
	p := o.p
	withPane := func(fn func(ctx context.Context, r *record, raw json.RawMessage) (any, error)) func(context.Context, plugin.Call) (any, error) {
		return func(ctx context.Context, c plugin.Call) (any, error) {
			var a paneArgs
			if err := c.Decode(&a); err != nil {
				return nil, err
			}
			r, err := o.session(ctx, a.pane(), a.ThreadID)
			if err != nil {
				return nil, err
			}
			return fn(ctx, r, c.Params)
		}
	}

	// Everything the view needs to draw a pane: the session, its messages,
	// whether it's working, and what it's waiting on the user for.
	p.Method("opencode.state", withPane(func(ctx context.Context, r *record, _ json.RawMessage) (any, error) {
		var info json.RawMessage
		if err := o.api(ctx, "GET", "/session/"+r.Session, r.Directory, nil, &info); err != nil {
			return nil, err
		}
		messages := json.RawMessage("[]")
		if err := o.api(ctx, "GET", "/session/"+r.Session+"/message", r.Directory, nil, &messages); err != nil {
			return nil, err
		}
		var statuses map[string]json.RawMessage
		_ = o.api(ctx, "GET", "/session/status", r.Directory, nil, &statuses)
		status := statuses[r.Session]
		if status == nil {
			status = json.RawMessage(`{"type":"idle"}`)
		}
		return map[string]any{
			"session":     info,
			"directory":   r.Directory,
			"messages":    messages,
			"status":      status,
			"permissions": o.pending(ctx, r, "/permission"),
			"questions":   o.pending(ctx, r, "/question"),
		}, nil
	}))

	p.Method("opencode.prompt", withPane(func(ctx context.Context, r *record, raw json.RawMessage) (any, error) {
		var a struct {
			Text  string `json:"text"`
			Model string `json:"model"`
			Agent string `json:"agent"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		if strings.TrimSpace(a.Text) == "" {
			return nil, errors.New("say something")
		}
		body := map[string]any{"parts": []any{map[string]string{"type": "text", "text": a.Text}}}
		model := a.Model
		if model == "" {
			p.Setting("model", &model)
		}
		if prov, id, ok := strings.Cut(model, "/"); ok && prov != "" && id != "" {
			body["model"] = map[string]string{"providerID": prov, "modelID": id}
		}
		if a.Agent != "" {
			body["agent"] = a.Agent
		}
		return struct{}{}, o.api(ctx, "POST", "/session/"+r.Session+"/prompt_async", r.Directory, body, nil)
	}))

	p.Method("opencode.abort", withPane(func(ctx context.Context, r *record, _ json.RawMessage) (any, error) {
		return struct{}{}, o.api(ctx, "POST", "/session/"+r.Session+"/abort", r.Directory, map[string]any{}, nil)
	}))

	// A permission prompt's answer: once, always or reject.
	p.Method("opencode.permission", withPane(func(ctx context.Context, r *record, raw json.RawMessage) (any, error) {
		var a struct {
			ID    string `json:"id"`
			Reply string `json:"reply"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		if a.Reply != "once" && a.Reply != "always" && a.Reply != "reject" {
			return nil, errors.New("reply once, always or reject")
		}
		return struct{}{}, o.api(ctx, "POST", "/permission/"+url.PathEscape(a.ID)+"/reply", r.Directory, map[string]string{"reply": a.Reply}, nil)
	}))

	// A question's answers (a list of chosen labels per question), or reject.
	p.Method("opencode.question", withPane(func(ctx context.Context, r *record, raw json.RawMessage) (any, error) {
		var a struct {
			ID      string     `json:"id"`
			Answers [][]string `json:"answers"`
			Reject  bool       `json:"reject"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return nil, err
		}
		path := "/question/" + url.PathEscape(a.ID)
		if a.Reject {
			return struct{}{}, o.api(ctx, "POST", path+"/reject", r.Directory, map[string]any{}, nil)
		}
		return struct{}{}, o.api(ctx, "POST", path+"/reply", r.Directory, map[string]any{"answers": a.Answers}, nil)
	}))

	// The models the composer offers: configured providers' models, and the defaults.
	p.Method("opencode.models", withPane(func(ctx context.Context, r *record, _ json.RawMessage) (any, error) {
		var res struct {
			Providers []struct {
				ID     string `json:"id"`
				Name   string `json:"name"`
				Models map[string]struct {
					ID   string `json:"id"`
					Name string `json:"name"`
				} `json:"models"`
			} `json:"providers"`
		}
		if err := o.api(ctx, "GET", "/config/providers", r.Directory, nil, &res); err != nil {
			return nil, err
		}
		type model struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		var models []model
		for _, pr := range res.Providers {
			for id, m := range pr.Models {
				name := m.Name
				if name == "" {
					name = id
				}
				models = append(models, model{ID: pr.ID + "/" + id, Name: pr.Name + " · " + name})
			}
		}
		// What a prompt without a model gets: ours, else OpenCode's config's
		// (else OpenCode picks, and the view says so).
		def := ""
		p.Setting("model", &def)
		if def == "" {
			var cfg struct {
				Model string `json:"model"`
			}
			_ = o.api(ctx, "GET", "/config", r.Directory, nil, &cfg)
			def = cfg.Model
		}
		var agents []struct {
			Name string `json:"name"`
			Mode string `json:"mode"`
		}
		_ = o.api(ctx, "GET", "/agent", r.Directory, nil, &agents)
		primary := []string{}
		for _, a := range agents {
			if a.Mode != "subagent" {
				primary = append(primary, a.Name)
			}
		}
		if models == nil {
			models = []model{}
		}
		return map[string]any{"models": models, "default": def, "agents": primary}, nil
	}))

	// Badges on threads whose OpenCode is working or waiting on the user.
	p.Method("opencode.badges", func(context.Context, plugin.Call) (any, error) {
		o.load()
		o.mu.Lock()
		defer o.mu.Unlock()
		out := map[string]any{}
		for sid, r := range o.bySession {
			switch {
			case len(o.waiting[sid]) > 0:
				out[r.Thread] = map[string]string{"text": "needs you", "tone": "warn"}
			case o.busy[sid]:
				if _, ok := out[r.Thread]; !ok {
					out[r.Thread] = map[string]string{"text": "working", "tone": "live"}
				}
			}
		}
		return out, nil
	})

	p.Kinds(func(event string, raw json.RawMessage) {
		if event != "deleted" {
			return
		}
		var t struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(raw, &t)
		o.mu.Lock()
		for sid, r := range o.bySession {
			if r.Pane == t.ID {
				delete(o.bySession, sid)
				delete(o.busy, sid)
				delete(o.waiting, sid)
			}
		}
		o.mu.Unlock()
	})
}

// pending lists the session's permission or question requests.
func (o *opencode) pending(ctx context.Context, r *record, path string) []json.RawMessage {
	var all []json.RawMessage
	_ = o.api(ctx, "GET", path, r.Directory, nil, &all)
	out := []json.RawMessage{}
	for _, raw := range all {
		var x struct {
			SessionID string `json:"sessionID"`
		}
		if json.Unmarshal(raw, &x) == nil && x.SessionID == r.Session {
			out = append(out, raw)
		}
	}
	return out
}

// --- events -----------------------------------------------------------------

// Forwarded to the pane's view; the rest (plugins, catalogs, LSP…) aren't.
var forwarded = map[string]bool{
	"message.updated": true, "message.removed": true, "message.part.updated": true, "message.part.removed": true,
	"message.part.delta": true, "session.status": true, "session.idle": true, "session.error": true, "session.updated": true,
	"permission.asked": true, "permission.replied": true, "question.asked": true, "question.replied": true, "question.rejected": true,
	"todo.updated": true,
}

// events follows the server's events for every directory, for as long as
// the plugin runs, and hands each session's to its pane's view.
func (o *opencode) events() {
	for {
		if err := o.follow(); err != nil {
			fmt.Fprintln(os.Stderr, "opencode events:", err)
		}
		time.Sleep(2 * time.Second)
	}
}

func (o *opencode) follow() error {
	o.load()
	// Nothing to follow before a pane has a session: don't start the server for nothing.
	o.mu.Lock()
	n := len(o.bySession)
	o.mu.Unlock()
	o.srvMu.Lock()
	running := o.cmd != nil
	o.srvMu.Unlock()
	if n == 0 && !running {
		return nil
	}
	base, err := o.server()
	if err != nil {
		return err
	}
	req, _ := http.NewRequest("GET", base+"/global/event", nil)
	req.SetBasicAuth("opencode", o.password)
	req.Header.Set("Accept", "text/event-stream")
	res, err := (&http.Client{}).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("events: %s", res.Status)
	}
	// What was busy may have finished while we weren't listening.
	o.mu.Lock()
	o.busy = map[string]bool{}
	o.mu.Unlock()
	rd := bufio.NewReaderSize(res.Body, 1<<20)
	for {
		line, err := rd.ReadBytes('\n')
		if err != nil {
			return err
		}
		data, ok := bytes.CutPrefix(bytes.TrimRight(line, "\r\n"), []byte("data: "))
		if !ok {
			continue
		}
		var ev struct {
			Payload struct {
				Type       string          `json:"type"`
				Properties json.RawMessage `json:"properties"`
			} `json:"payload"`
		}
		if json.Unmarshal(data, &ev) != nil || !forwarded[ev.Payload.Type] {
			continue
		}
		o.handle(ev.Payload.Type, ev.Payload.Properties)
	}
}

func (o *opencode) handle(typ string, props json.RawMessage) {
	var x struct {
		SessionID string                `json:"sessionID"`
		ID        string                `json:"id"`
		RequestID string                `json:"requestID"`
		Status    struct{ Type string } `json:"status"`
		Info      struct {
			SessionID string `json:"sessionID"`
		} `json:"info"`
	}
	_ = json.Unmarshal(props, &x)
	sid := x.SessionID
	if sid == "" {
		sid = x.Info.SessionID
	}
	o.mu.Lock()
	r := o.bySession[sid]
	if r == nil {
		o.mu.Unlock()
		return
	}
	badges := false
	switch typ {
	case "session.status":
		was := o.busy[sid]
		o.busy[sid] = x.Status.Type != "idle"
		badges = was != o.busy[sid]
	case "session.idle":
		badges = o.busy[sid]
		o.busy[sid] = false
	case "permission.asked", "question.asked":
		if o.waiting[sid] == nil {
			o.waiting[sid] = map[string]bool{}
		}
		o.waiting[sid][x.ID] = true
		badges = true
	case "permission.replied", "question.replied", "question.rejected":
		delete(o.waiting[sid], x.RequestID)
		badges = true
	}
	pane := r.Pane
	o.mu.Unlock()
	_ = o.p.Emit(map[string]any{"event": "opencode.event", "pane": pane, "type": typ, "properties": props})
	if badges {
		_ = o.p.Emit(map[string]any{"event": "opencode.ui.changed"})
	}
}
