package external

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/version"
)

const (
	initTimeout    = 10 * time.Second
	callTimeout    = 2 * time.Minute
	stopGrace      = 3 * time.Second
	restartMin     = time.Second
	restartMax     = time.Minute
	healthyRunTime = time.Minute
)

// Plugin is one installed plugin, run as a process and kept running.
type Plugin struct {
	m     Manifest
	dir   string
	stamp string
	icon  string
	h     plugin.Host

	mu       sync.Mutex
	c        *conn
	cmd      *exec.Cmd
	exited   chan struct{} // closed when the running process has exited
	stopped  bool
	stopCh   chan struct{}
	streams  map[string]*webrtc.DataChannel
	sessions map[string]plugin.Session
	nextID   int64
	// removeAgents forgets the agents it added.
	removeAgents []func()
}

// New makes a plugin from its directory and manifest.
func New(dir string, m Manifest) *Plugin {
	return &Plugin{m: m, dir: dir, stamp: Stamp(dir, m), icon: readIcon(dir, m), stopCh: make(chan struct{}), streams: map[string]*webrtc.DataChannel{}, sessions: map[string]plugin.Session{}}
}

// IconMaxBytes is the most a plugin's icon file may be.
const IconMaxBytes = 32 << 10

var iconTypes = map[string]string{".svg": "image/svg+xml", ".png": "image/png"}

// readIcon reads a plugin's icon as a data: URL; "" if it has none, or it's
// missing or too big (logged: the plugin works without it).
func readIcon(dir string, m Manifest) string {
	if m.Icon == "" {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(dir, filepath.Clean(m.Icon)))
	if err == nil && len(b) > IconMaxBytes {
		err = fmt.Errorf("it's over %d KB", IconMaxBytes>>10)
	}
	if err != nil {
		slog.Warn("plugin icon not shown", "plugin", m.ID, "err", err)
		return ""
	}
	return "data:" + iconTypes[strings.ToLower(filepath.Ext(m.Icon))] + ";base64," + base64.StdEncoding.EncodeToString(b)
}

// Stamp says which build of a plugin is installed: its program's size and
// time, so reinstalling a rebuilt one (same manifest) restarts it.
func Stamp(dir string, m Manifest) string {
	if len(m.Command) == 0 {
		return ""
	}
	name := m.Command[0]
	if !filepath.IsAbs(name) {
		name = filepath.Join(dir, name)
	}
	info, err := os.Stat(name)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())
}

// Dir is where it's installed.
func (p *Plugin) Dir() string { return p.dir }

// Spec is its plugin.json.
func (p *Plugin) Spec() Manifest { return p.m }

func (p *Plugin) Manifest() plugin.Manifest {
	requires := p.m.Requires
	// Its agents are the agent plugin's to run.
	if len(p.m.Contributes.Agents) > 0 && !slices.Contains(requires, "agent") {
		requires = append(slices.Clip(requires), "agent")
	}
	return plugin.Manifest{
		ID: p.m.ID, Title: p.m.Title, Version: p.m.Version, API: p.m.API,
		Requires: requires, Optional: p.m.Optional, Permissions: p.m.Permissions,
		Web: p.m.Web != "", Settings: p.m.Settings, SettingsPage: p.m.SettingsPage, UI: p.m.Contributes.UI,
		Icon: p.icon,
	}
}

func (p *Plugin) has(perm string) bool { return slices.Contains(p.m.Permissions, perm) }

// Start registers what plugin.json declares and starts the process.
func (p *Plugin) Start(h plugin.Host) error {
	p.h = h
	c := p.m.Contributes
	for _, r := range c.RPC {
		var opts []plugin.RPCOption
		if r.Remote {
			opts = append(opts, plugin.Remote())
		}
		if r.Slow {
			opts = append(opts, plugin.Slow())
		}
		method := r.Method
		h.HandleRPC(method, func(ctx context.Context, rc plugin.RPCContext, params json.RawMessage) (any, error) {
			res, err := p.call(ctx, "rpc", map[string]any{"method": method, "params": params, "remote": rc.Remote})
			if err != nil {
				return nil, err
			}
			return res, nil
		}, opts...)
	}
	for _, prefix := range c.Channels {
		h.HandleChannel(prefix, p.serveChannel)
	}
	for _, kind := range c.Sessions {
		h.HandleSession(kind, p.sessionHandler(kind))
	}
	for _, t := range c.Tools {
		h.AddTools(p.tool(t))
	}
	for _, k := range c.Kinds {
		h.AddKind(plugin.KindHandler{
			Kind: plugin.Kind{Kind: k.Kind, Title: k.Title, Thread: k.Thread, Single: k.Single},
			Created: func(t protocol.Thread, cp plugin.CreateParams) error {
				p.notify("kind.created", map[string]any{"thread": t, "params": cp})
				return nil
			},
			Delete: func(t protocol.Thread, _ plugin.DeleteParams) func() {
				return func() { p.notify("kind.deleted", map[string]any{"thread": t}) }
			},
		})
	}
	if len(c.Events) > 0 {
		h.Bus().SubscribeRaw(func(topic string, payload json.RawMessage) {
			if slices.Contains(c.Events, topic) {
				p.notify("event", map[string]any{"topic": topic, "payload": payload})
			}
		})
	}
	if a := c.Agent; a != nil && a.SystemPrompt != "" {
		h.ContributeAgent(func(plugin.AgentLaunch) plugin.AgentContribution {
			return plugin.AgentContribution{SystemPrompt: []string{a.SystemPrompt}}
		})
	}
	if len(c.Agents) > 0 {
		svc, ok := plugin.Lookup[plugin.AgentService](h, plugin.ServiceAgent)
		if !ok {
			return errors.New("it adds agents, but the agent plugin isn't running")
		}
		for _, a := range c.Agents {
			prog, err := p.resolve(a.Command[0])
			if err != nil {
				for _, remove := range p.removeAgents {
					remove()
				}
				p.removeAgents = nil
				return fmt.Errorf("agent %s: %w", a.Kind, err)
			}
			cmd := append([]string{prog}, a.Command[1:]...)
			p.removeAgents = append(p.removeAgents, svc.AddAgent(h, plugin.AgentDef{Kind: a.Kind, Title: a.Title, Icon: p.icon, Command: cmd}))
		}
	}
	if p.m.HasProcess() {
		go p.supervise()
	}
	return nil
}

// Stop stops the process and keeps it stopped.
func (p *Plugin) Stop() {
	p.mu.Lock()
	if p.stopped {
		p.mu.Unlock()
		return
	}
	p.stopped = true
	close(p.stopCh)
	c, cmd, exited := p.c, p.cmd, p.exited
	removeAgents := p.removeAgents
	p.removeAgents = nil
	p.mu.Unlock()
	for _, remove := range removeAgents {
		remove()
	}
	if c == nil || cmd == nil {
		return
	}
	c.notify("shutdown", struct{}{})
	select {
	case <-exited:
	case <-time.After(stopGrace):
		_ = cmd.Process.Kill()
		<-exited
	}
}

// Running reports whether its process is up.
func (p *Plugin) Running() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.m.HasProcess() {
		return p.h != nil && !p.stopped
	}
	return p.c != nil
}

// supervise runs the process, restarting it with backoff when it exits.
func (p *Plugin) supervise() {
	wait := restartMin
	for {
		started := time.Now()
		err := p.run()
		select {
		case <-p.stopCh:
			return
		default:
		}
		if time.Since(started) > healthyRunTime {
			wait = restartMin
		}
		slog.Warn("plugin stopped; restarting", "plugin", p.m.ID, "err", err, "in", wait)
		select {
		case <-p.stopCh:
			return
		case <-time.After(wait):
		}
		wait = min(wait*2, restartMax)
	}
}

func (p *Plugin) dataDir() string { return filepath.Join(p.h.DataDir(), "plugin-data", p.m.ID) }

// command resolves the program.
func (p *Plugin) command() (string, error) { return p.resolve(p.m.Command[0]) }

// resolve finds a program: a path in the plugin's directory, or one on PATH.
func (p *Plugin) resolve(name string) (string, error) {
	if filepath.IsAbs(name) {
		return name, nil
	}
	if strings.ContainsRune(name, filepath.Separator) || strings.HasPrefix(name, ".") {
		return filepath.Join(p.dir, name), nil
	}
	if _, err := os.Stat(filepath.Join(p.dir, name)); err == nil {
		return filepath.Join(p.dir, name), nil
	}
	return exec.LookPath(name)
}

// run runs the process once, until it exits.
func (p *Plugin) run() error {
	prog, err := p.command()
	if err != nil {
		return err
	}
	data := p.dataDir()
	if err := os.MkdirAll(data, 0o700); err != nil {
		return err
	}
	cmd := exec.Command(prog, p.m.Command[1:]...)
	cmd.Dir = data
	cmd.Env = append(os.Environ(),
		"EVERYWHERE_PLUGIN_ID="+p.m.ID,
		"EVERYWHERE_PLUGIN_DIR="+p.dir,
		"EVERYWHERE_PLUGIN_DATA="+data,
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go logLines(p.m.ID, stderr)
	c := newConn(stdin, p.handle)
	served := make(chan error, 1)
	go func() { served <- c.serve(stdout) }()

	ctx, cancel := context.WithTimeout(context.Background(), initTimeout)
	res, err := c.call(ctx, "initialize", map[string]any{
		"api":      plugin.API,
		"id":       p.m.ID,
		"host":     map[string]any{"version": version.Version, "device": p.h.Info()},
		"dataDir":  data,
		"settings": Values(p.h.Store(), p.m),
	})
	cancel()
	var init struct {
		API int `json:"api"`
	}
	if err == nil {
		err = json.Unmarshal(res, &init)
	}
	if err == nil && init.API != plugin.API {
		err = fmt.Errorf("it speaks plugin API %d; this daemon has %d", init.API, plugin.API)
	}
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return fmt.Errorf("initialize: %w", err)
	}

	p.mu.Lock()
	if p.stopped {
		p.mu.Unlock()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil
	}
	exited := make(chan struct{})
	p.c, p.cmd, p.exited = c, cmd, exited
	p.mu.Unlock()
	slog.Info("plugin started", "plugin", p.m.ID)

	err = <-served
	waitErr := cmd.Wait()
	close(exited)
	p.mu.Lock()
	p.c, p.cmd = nil, nil
	streams := p.streams
	p.streams = map[string]*webrtc.DataChannel{}
	sessions := p.sessions
	p.sessions = map[string]plugin.Session{}
	p.mu.Unlock()
	// What it had open dies with it.
	for _, dc := range streams {
		_ = dc.Close()
	}
	for _, s := range sessions {
		s.Close("The plugin stopped")
	}
	if waitErr != nil {
		return waitErr
	}
	return err
}

func logLines(id string, r io.Reader) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		slog.Info("plugin: "+sc.Text(), "plugin", id)
	}
}

// Reconfigure tells the process its settings changed.
func (p *Plugin) Reconfigure() {
	p.notify("config", map[string]any{"settings": Values(p.h.Store(), p.m)})
}

// call asks the process something.
func (p *Plugin) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	p.mu.Lock()
	c := p.c
	p.mu.Unlock()
	if c == nil {
		return nil, fmt.Errorf("the %s plugin isn't running", p.m.Title)
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, callTimeout)
		defer cancel()
	}
	return c.call(ctx, method, params)
}

func (p *Plugin) notify(method string, params any) {
	p.mu.Lock()
	c := p.c
	p.mu.Unlock()
	if c != nil {
		c.notify(method, params)
	}
}

func (p *Plugin) newID(prefix string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.nextID++
	return prefix + strconv.FormatInt(p.nextID, 10)
}

// tool makes a declared tool callable by claude, prefixed with the plugin's id.
func (p *Plugin) tool(t Tool) plugin.Tool {
	name := t.Name
	return plugin.Tool{
		Ask: t.Ask,
		Tool: mcp.Tool{
			Name: p.m.ToolName(name), Title: t.Title, Description: t.Description,
			InputSchema: t.InputSchema,
			Annotations: mcp.Annotations{ReadOnly: t.ReadOnly},
			Call: func(ctx context.Context, c mcp.Caller, args json.RawMessage) (*mcp.Result, error) {
				raw, err := p.call(ctx, "tool", map[string]any{"name": name, "args": args, "threadId": c.ThreadID})
				if err != nil {
					return nil, err
				}
				var res struct {
					mcp.Result
					Text *string `json:"text"`
				}
				if err := json.Unmarshal(raw, &res); err != nil {
					return nil, fmt.Errorf("the plugin answered %s", raw)
				}
				if res.Text != nil {
					return &mcp.Result{Content: []mcp.Content{{Type: "text", Text: *res.Text}}, IsError: res.IsError}, nil
				}
				return &res.Result, nil
			},
		},
	}
}

// serveChannel passes a data channel through to the process as a stream.
func (p *Plugin) serveChannel(ctx context.Context, c plugin.ChannelContext, dc *webrtc.DataChannel) {
	if !p.Running() {
		_ = dc.Close()
		return
	}
	stream := p.newID("s")
	p.mu.Lock()
	p.streams[stream] = dc
	p.mu.Unlock()
	p.notify("channel.open", map[string]any{"stream": stream, "label": c.Label, "rest": c.Rest})
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if msg.IsString {
			p.notify("channel.message", map[string]any{"stream": stream, "text": string(msg.Data)})
		} else {
			p.notify("channel.message", map[string]any{"stream": stream, "data": base64.StdEncoding.EncodeToString(msg.Data)})
		}
	})
	go func() {
		<-ctx.Done()
		p.mu.Lock()
		_, open := p.streams[stream]
		delete(p.streams, stream)
		p.mu.Unlock()
		if open {
			p.notify("channel.close", map[string]any{"stream": stream})
		}
	}()
}

func (p *Plugin) sessionHandler(kind string) plugin.SessionHandler {
	return plugin.SessionHandler{
		Open: func(ctx context.Context, s plugin.Session, offer string, params json.RawMessage) (string, error) {
			p.mu.Lock()
			p.sessions[s.ID()] = s
			p.mu.Unlock()
			raw, err := p.call(ctx, "session.open", map[string]any{"session": s.ID(), "kind": kind, "offer": offer, "params": params})
			if err != nil {
				return "", err
			}
			var res struct {
				Answer string `json:"answer"`
			}
			if err := json.Unmarshal(raw, &res); err != nil || res.Answer == "" {
				return "", errors.New("the plugin gave no answer")
			}
			return res.Answer, nil
		},
		Candidate: func(s plugin.Session, c webrtc.ICECandidateInit) {
			p.notify("session.candidate", map[string]any{"session": s.ID(), "candidate": c})
		},
		Closed: func(s plugin.Session) {
			p.mu.Lock()
			delete(p.sessions, s.ID())
			p.mu.Unlock()
			p.notify("session.closed", map[string]any{"session": s.ID()})
		},
	}
}

// handle answers the process's requests, holding it to its permissions.
func (p *Plugin) handle(method string, raw json.RawMessage) (any, error) {
	var a struct {
		Event     json.RawMessage          `json:"event"`
		Stream    string                   `json:"stream"`
		Text      *string                  `json:"text"`
		Data      string                   `json:"data"`
		Session   string                   `json:"session"`
		Candidate *webrtc.ICECandidateInit `json:"candidate"`
		Reason    string                   `json:"reason"`
		ID        string                   `json:"id"`
		ThreadID  string                   `json:"threadId"`
		Name      string                   `json:"name"`
		Prompt    string                   `json:"prompt"`
		Wake      bool                     `json:"wake"`
		Level     string                   `json:"level"`
		Message   string                   `json:"message"`
	}
	if err := plugin.Unmarshal(raw, &a); err != nil {
		return nil, err
	}
	need := func(perm string) error {
		if !p.has(perm) {
			return fmt.Errorf("%s needs the %q permission", method, perm)
		}
		return nil
	}
	switch method {
	case "host.emit":
		var ev struct {
			Event string `json:"event"`
		}
		if json.Unmarshal(a.Event, &ev) != nil || !strings.HasPrefix(ev.Event, p.m.ID+".") {
			return nil, fmt.Errorf("a plugin's events are named %q", p.m.ID+".…")
		}
		p.h.Emit(a.Event)
		return plugin.Empty{}, nil
	case "host.channel.send":
		p.mu.Lock()
		dc := p.streams[a.Stream]
		p.mu.Unlock()
		if dc == nil {
			return nil, errors.New("no such stream")
		}
		if a.Text != nil {
			return plugin.Empty{}, dc.SendText(*a.Text)
		}
		b, err := base64.StdEncoding.DecodeString(a.Data)
		if err != nil {
			return nil, err
		}
		return plugin.Empty{}, dc.Send(b)
	case "host.channel.close":
		p.mu.Lock()
		dc := p.streams[a.Stream]
		delete(p.streams, a.Stream)
		p.mu.Unlock()
		if dc != nil {
			_ = dc.Close()
		}
		return plugin.Empty{}, nil
	case "host.session.candidate", "host.session.close":
		p.mu.Lock()
		s := p.sessions[a.Session]
		p.mu.Unlock()
		if s == nil {
			return nil, errors.New("no such session")
		}
		if method == "host.session.close" {
			s.Close(a.Reason)
		} else if a.Candidate != nil {
			s.SendCandidate(*a.Candidate)
		}
		return plugin.Empty{}, nil
	case "host.config.get":
		return Values(p.h.Store(), p.m), nil
	case "host.kv.get", "host.kv.set", "host.kv.delete", "host.kv.list", "host.kv.scopes":
		var kp plugin.KVParams
		if err := plugin.Unmarshal(raw, &kp); err != nil {
			return nil, err
		}
		return plugin.CallKV(p.h.KV(), strings.TrimPrefix(method, "host.kv."), kp)
	case "host.threads.get":
		return p.h.Threads().Live(a.ID)
	case "host.threads.workdir":
		return p.h.Threads().Workdir(a.ID)
	case "host.agent.notify", "host.agent.send":
		if err := need(plugin.PermAgentNotify); err != nil {
			return nil, err
		}
		agent, ok := plugin.Lookup[plugin.AgentService](p.h, plugin.ServiceAgent)
		if !ok {
			return nil, errors.New("claude threads aren't available on this device")
		}
		text := ""
		if a.Text != nil {
			text = *a.Text
		}
		if method == "host.agent.send" {
			return plugin.Empty{}, agent.Send(a.ThreadID, text)
		}
		if a.Prompt == "" {
			a.Prompt = text
		}
		agent.Notify(a.ThreadID, a.Name, text, a.Prompt, a.Wake)
		return plugin.Empty{}, nil
	case "host.log":
		lvl := slog.LevelInfo
		switch a.Level {
		case "debug":
			lvl = slog.LevelDebug
		case "warn":
			lvl = slog.LevelWarn
		case "error":
			lvl = slog.LevelError
		}
		slog.Log(context.Background(), lvl, "plugin: "+a.Message, "plugin", p.m.ID)
		return plugin.Empty{}, nil
	}
	return nil, fmt.Errorf("unknown method %q", method)
}
