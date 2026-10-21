package external_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/harness"
	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin/external"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin/plugintest"
	agentplugin "github.com/conner-replogle/everywhere/daemon/internal/plugins/agent"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	sdk "github.com/conner-replogle/everywhere/daemon/sdk/plugin"
)

// The test binary is also the plugin: run with EW_TEST_PLUGIN=1, it serves
// the hello plugin over stdin/stdout.
func TestMain(m *testing.M) {
	if os.Getenv("EW_TEST_PLUGIN") == "1" {
		p := sdk.New()
		p.Method("hello.greet", func(_ context.Context, c sdk.Call) (any, error) {
			var a struct{ Name string }
			_ = c.Decode(&a)
			greeting, team := "Hello", ""
			p.Setting("greeting", &greeting)
			p.Setting("team", &team)
			return map[string]any{"greeting": greeting + ", " + a.Name, "team": team, "remote": c.Remote, "dataDir": p.Init.DataDir}, nil
		})
		p.Method("hello.remember", func(_ context.Context, c sdk.Call) (any, error) {
			var a struct{ Thread, Value string }
			_ = c.Decode(&a)
			if err := p.KV().Set("thread:"+a.Thread, "x", a.Value); err != nil {
				return nil, err
			}
			var back string
			ok, err := p.KV().Get("thread:"+a.Thread, "x", &back)
			if err != nil || !ok {
				return nil, fmt.Errorf("read back: %v %v", ok, err)
			}
			// The host's settings scope isn't the plugin's to write.
			if p.KV().Set("settings", "greeting", "sneaky") == nil {
				return nil, errors.New("wrote the settings scope")
			}
			return back, nil
		})
		p.Method("hello.crash", func(context.Context, sdk.Call) (any, error) {
			os.Exit(3)
			return nil, nil
		})
		p.Tool("wave", func(_ context.Context, c sdk.ToolCall) (string, error) {
			// Without agent.notify, the host refuses.
			if err := p.NotifyAgent(c.ThreadID, "wave", "hi", false); err == nil {
				return "", nil
			} else if !strings.Contains(err.Error(), "permission") {
				return "", err
			}
			return "waved at " + c.ThreadID, nil
		})
		if err := p.Run(); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func helloManifest(t *testing.T) (string, external.Manifest) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	m := external.Manifest{
		ID: "hello", Title: "Hello", Version: "0.1.0", API: plugin.API,
		Command:     []string{exe},
		Permissions: []string{plugin.PermAgentTools, plugin.PermRemote},
		Contributes: external.Contributes{
			RPC:   []external.RPC{{Method: "hello.greet", Remote: true}, {Method: "hello.crash"}, {Method: "hello.remember"}},
			Tools: []external.Tool{{Name: "wave", Description: "Wave.", InputSchema: json.RawMessage(`{"type":"object"}`)}},
		},
		Settings: []protocol.PluginSetting{
			{Key: "greeting", Type: "string", Title: "Greeting", Default: json.RawMessage(`"Hello"`)},
			{Key: "token", Type: "secret", Title: "Token"},
			{Key: "team", Type: "string", Title: "Team", Scope: "account"},
		},
	}
	dir := filepath.Join(t.TempDir(), "hello")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(m)
	if err := os.WriteFile(filepath.Join(dir, external.ManifestFile), b, 0o644); err != nil {
		t.Fatal(err)
	}
	return dir, m
}

func waitRunning(t *testing.T, p *external.Plugin) {
	t.Helper()
	for range 200 {
		if p.Running() {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("plugin didn't start")
}

func TestExternalPlugin(t *testing.T) {
	t.Setenv("EW_TEST_PLUGIN", "1")
	dir, m := helloManifest(t)
	p := external.New(dir, m)
	r, _ := plugintest.Start(t, p)
	waitRunning(t, p)
	ctx := context.Background()

	greet := func(remote bool) (map[string]any, error) {
		res, err := r.Call(ctx, "hello.greet", plugin.RPCContext{Remote: remote}, json.RawMessage(`{"name":"Ada"}`))
		if err != nil {
			return nil, err
		}
		var out map[string]any
		return out, json.Unmarshal(res.(json.RawMessage), &out)
	}
	out, err := greet(true)
	if err != nil || out["greeting"] != "Hello, Ada" || out["remote"] != true {
		t.Fatalf("greet: %v %v", out, err)
	}
	if !strings.Contains(out["dataDir"].(string), filepath.Join("plugin-data", "hello")) {
		t.Errorf("data dir %v", out["dataDir"])
	}
	if _, err := r.Call(ctx, "hello.crash", plugin.RPCContext{Remote: true}, nil); err == nil {
		t.Error("a method that isn't remote answered over the hub")
	}

	// Its tool is on the daemon's MCP server, named for the plugin.
	endpoint, token, release, err := r.MCP().Grant(mcp.Caller{ThreadID: "t1"})
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	req, _ := http.NewRequest(http.MethodPost, endpoint, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hello_wave","arguments":{}}}`))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var res struct {
		Result mcp.Result `json:"result"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&res)
	resp.Body.Close()
	if len(res.Result.Content) != 1 || res.Result.Content[0].Text != "waved at t1" || res.Result.IsError {
		t.Errorf("tool: %+v", res.Result)
	}
	if got := strings.Join(r.Allowed(), ","); got != "mcp__everywhere__hello_wave" {
		t.Errorf("allowed %s", got)
	}

	// A crash restarts it.
	_, _ = r.Call(ctx, "hello.crash", plugin.RPCContext{}, nil)
	for range 200 {
		if _, err := greet(false); err == nil {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("plugin didn't come back after crashing")
}

func TestManifestValidation(t *testing.T) {
	ok := external.Manifest{ID: "hello", Title: "Hello", API: plugin.API, Command: []string{"./hello"}}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mod := range map[string]func(*external.Manifest){
		"reserved id": func(m *external.Manifest) { m.ID = "agent" },
		"bad id":      func(m *external.Manifest) { m.ID = "Hello World" },
		"other api":   func(m *external.Manifest) { m.API = plugin.API + 1 },
		"no command":  func(m *external.Manifest) { m.Command = nil; m.Contributes.RPC = []external.RPC{{Method: "hello.x"}} },
		"agent of another kind": func(m *external.Manifest) {
			m.Permissions = []string{plugin.PermExec}
			m.Contributes.Agents = []external.Agent{{Kind: "claude", Title: "Claude", Command: []string{"x"}}}
		},
		"agent without exec": func(m *external.Manifest) {
			m.Contributes.Agents = []external.Agent{{Kind: "hello", Title: "Hello", Command: []string{"x"}}}
		},
		"agent without command": func(m *external.Manifest) {
			m.Permissions = []string{plugin.PermExec}
			m.Contributes.Agents = []external.Agent{{Kind: "hello", Title: "Hello"}}
		},
		"unprefixed method":   func(m *external.Manifest) { m.Contributes.RPC = []external.RPC{{Method: "threads.list"}} },
		"remote without perm": func(m *external.Manifest) { m.Contributes.RPC = []external.RPC{{Method: "hello.x", Remote: true}} },
		"unprefixed channel":  func(m *external.Manifest) { m.Contributes.Channels = []string{"term:"} },
		"tools without perm": func(m *external.Manifest) {
			m.Contributes.Tools = []external.Tool{{Name: "x", InputSchema: json.RawMessage(`{}`)}}
		},
		"kind without web":   func(m *external.Manifest) { m.Contributes.Kinds = []external.Kind{{Kind: "hello", Title: "Hello"}} },
		"unknown permission": func(m *external.Manifest) { m.Permissions = []string{"root"} },
		"web outside":        func(m *external.Manifest) { m.Web = "../x" },
		"bad setting type": func(m *external.Manifest) {
			m.Settings = []protocol.PluginSetting{{Key: "a", Type: "color", Title: "A"}}
		},
		"bad default": func(m *external.Manifest) {
			m.Settings = []protocol.PluginSetting{{Key: "a", Type: "number", Title: "A", Default: json.RawMessage(`"x"`)}}
		},
		"select without options": func(m *external.Manifest) {
			m.Settings = []protocol.PluginSetting{{Key: "a", Type: "select", Title: "A"}}
		},
		"ui method not its own": func(m *external.Manifest) {
			m.Contributes.UI = &protocol.PluginUI{Sidebar: &protocol.PluginUISource{Method: "threads.list"}}
		},
		"menu action without target": func(m *external.Manifest) {
			m.Contributes.UI = &protocol.PluginUI{DeviceMenu: []protocol.PluginAction{{Label: "x"}}}
		},
	} {
		m := ok
		mod(&m)
		if err := m.Validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// A plugin can be just an agent: no process of its own, a thread kind the
// agent plugin runs over ACP.
func TestAgentPlugin(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "acme-acp"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "icon.svg"), []byte("<svg/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := external.Manifest{
		ID: "acme", Title: "Acme", API: plugin.API, Permissions: []string{plugin.PermExec}, Icon: "icon.svg",
		Contributes: external.Contributes{Agents: []external.Agent{{Kind: "acme", Title: "Acme Agent", Command: []string{"acme-acp", "--acp"}}}},
	}
	if err := m.Validate(); err != nil {
		t.Fatal(err)
	}
	r, _ := plugintest.Start(t, agentplugin.New())
	p := external.New(dir, m)
	if err := r.StartPlugin(p); err != nil {
		t.Fatal(err)
	}
	if !p.Running() {
		t.Fatal("not running")
	}
	k, ok := r.Kind("acme")
	if !ok || k.View != "agent" || !k.Thread || k.Title != "Acme Agent" || !strings.HasPrefix(k.Icon, "data:image/svg+xml") {
		t.Fatalf("kind %+v %v", k.Kind, ok)
	}
	a, ok := harness.ByKind("acme")
	if !ok || strings.Join(a.Command, " ") != filepath.Join(dir, "acme-acp")+" --acp" {
		t.Fatalf("agent %+v %v", a, ok)
	}
	r.StopPlugin("acme")
	if _, ok := r.Kind("acme"); ok {
		t.Fatal("kind stayed")
	}
	if _, ok := harness.ByKind("acme"); ok {
		t.Fatal("agent stayed")
	}
}

func TestLoadOnlyEnabled(t *testing.T) {
	dir, _ := helloManifest(t)
	root := filepath.Dir(dir)
	_ = os.MkdirAll(filepath.Join(root, "broken"), 0o755)
	_ = os.WriteFile(filepath.Join(root, "broken", external.ManifestFile), []byte(`{"id":"broken"}`), 0o644)
	_, plugins := external.Load(root, func(string) bool { return false }, nil)
	if len(plugins) != 0 {
		t.Errorf("loaded disabled plugins: %v", plugins)
	}
	_, plugins = external.Load(root, func(id string) bool { return true }, nil)
	if len(plugins) != 1 || plugins[0].Manifest().ID != "hello" {
		t.Errorf("loaded %v", plugins)
	}
	installed, bad := external.Installed(root)
	if len(installed) != 1 || bad["broken"] == nil {
		t.Errorf("installed %v bad %v", installed, bad)
	}
}

// Enabling, disabling and removing take effect without a restart.
func TestReconcile(t *testing.T) {
	t.Setenv("EW_TEST_PLUGIN", "1")
	dir, _ := helloManifest(t)
	root := filepath.Dir(dir)
	var mu sync.Mutex
	on := false
	enabled := func(string) bool { mu.Lock(); defer mu.Unlock(); return on }
	set := func(_ string, v bool) error { mu.Lock(); on = v; mu.Unlock(); return nil }
	m, plugins := external.Load(root, enabled, set)
	if len(plugins) != 0 {
		t.Fatal("loaded a disabled plugin")
	}
	r, _ := plugintest.Start(t, m)
	m.Attach(r)
	greets := func() bool {
		_, err := r.Call(context.Background(), "hello.greet", plugin.RPCContext{}, nil)
		return err == nil
	}
	eventually := func(want bool, what string) {
		t.Helper()
		for range 300 {
			if greets() == want && r.Started("hello") == want {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("%s: hello running = %v", what, !want)
	}
	_ = set("hello", true)
	m.Reconcile()
	eventually(true, "after enabling")
	if _, err := r.Call(context.Background(), "plugins.disable", plugin.RPCContext{}, json.RawMessage(`{"id":"hello"}`)); err != nil {
		t.Fatal(err)
	}
	eventually(false, "after disabling")
	_ = set("hello", true)
	m.Reconcile()
	eventually(true, "after enabling again")
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	m.Reconcile()
	eventually(false, "after removing")
}

// A plugin that can't start (here: it requires one that isn't running) is
// reported once and not tried again until that changes.
func TestReconcileFailedStart(t *testing.T) {
	t.Setenv("EW_TEST_PLUGIN", "1")
	dir, man := helloManifest(t)
	man.Requires = []string{"needed"}
	b, _ := json.Marshal(man)
	if err := os.WriteFile(filepath.Join(dir, external.ManifestFile), b, 0o644); err != nil {
		t.Fatal(err)
	}
	m, plugins := external.Load(filepath.Dir(dir), func(string) bool { return true }, func(string, bool) error { return nil })
	r, c := plugintest.Start(t, append([]plugin.Plugin{m}, plugins...)...)
	if r.Started("hello") {
		t.Fatal("started without what it requires")
	}
	m.Attach(r)
	changes := func() int {
		n := 0
		for _, e := range c.Broadcasts() {
			if ev, ok := e.(protocol.RPCEvent); ok && ev.Event == protocol.EventPluginsChanged {
				n++
			}
		}
		return n
	}
	for range 200 {
		if changes() > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	before := changes()
	for range 5 {
		m.Reconcile()
		time.Sleep(30 * time.Millisecond)
	}
	if n := changes(); n != before {
		t.Fatalf("plugins.changed %d more times for a plugin that still can't start", n-before)
	}
	res, err := r.Call(context.Background(), "plugins.installed", plugin.RPCContext{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	list := res.([]external.InstalledPlugin)
	if len(list) != 1 || list[0].ID != "hello" || list[0].Error == "" {
		t.Fatalf("installed = %+v, want hello once, with its error", list)
	}

	if err := r.StartPlugin(&stub{id: "needed"}); err != nil {
		t.Fatal(err)
	}
	m.Reconcile()
	for range 300 {
		if r.Started("hello") {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("not started once what it requires was running")
}

type stub struct{ id string }

func (s *stub) Manifest() plugin.Manifest {
	return plugin.Manifest{ID: s.id, Title: s.id, API: plugin.API, Builtin: true}
}
func (s *stub) Start(plugin.Host) error { return nil }
func (s *stub) Stop()                   {}

func TestSettingsAndKV(t *testing.T) {
	t.Setenv("EW_TEST_PLUGIN", "1")
	dir, _ := helloManifest(t)
	m, plugins := external.Load(filepath.Dir(dir), func(string) bool { return true }, func(string, bool) error { return nil })
	r, c := plugintest.Start(t, append([]plugin.Plugin{m}, plugins...)...)
	waitRunning(t, plugins[0].(*external.Plugin))
	ctx := context.Background()
	call := func(method string, remote bool, params any) (json.RawMessage, error) {
		raw, _ := json.Marshal(params)
		res, err := r.Call(ctx, method, plugin.RPCContext{Remote: remote}, raw)
		if err != nil {
			return nil, err
		}
		if b, ok := res.(json.RawMessage); ok {
			return b, nil
		}
		return json.Marshal(res)
	}
	greet := func() map[string]any {
		raw, err := call("hello.greet", false, map[string]string{"name": "Ada"})
		if err != nil {
			t.Fatal(err)
		}
		var out map[string]any
		_ = json.Unmarshal(raw, &out)
		return out
	}
	eventually := func(what string, ok func() bool) {
		t.Helper()
		for range 200 {
			if ok() {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("never: %s", what)
	}

	if g := greet()["greeting"]; g != "Hello, Ada" {
		t.Errorf("default greeting: %v", g)
	}
	raw, err := call("plugins.setSettings", false, map[string]any{"id": "hello", "values": map[string]any{"greeting": "Hi", "token": "sk-secret1234"}})
	if err != nil {
		t.Fatal(err)
	}
	var view map[string]external.SettingView
	_ = json.Unmarshal(raw, &view)
	if view["token"].Value != nil || view["token"].Hint != "1234" || !view["token"].Set {
		t.Errorf("secret shown: %+v", view["token"])
	}
	eventually("the plugin hears of its new settings", func() bool { return greet()["greeting"] == "Hi, Ada" })

	for name, values := range map[string]map[string]any{
		"wrong type":      {"greeting": 3},
		"unknown":         {"nope": "x"},
		"account setting": {"team": "x"},
	} {
		if _, err := call("plugins.setSettings", false, map[string]any{"id": "hello", "values": values}); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	// Account values come from the hub only.
	if _, err := call("plugins.setAccountSettings", false, map[string]any{"id": "hello", "values": map[string]any{"team": "x"}}); err == nil {
		t.Error("a browser set account settings")
	}
	if _, err := call("plugins.setAccountSettings", true, map[string]any{"id": "hello", "values": map[string]any{"team": "core"}}); err != nil {
		t.Fatal(err)
	}
	eventually("account settings reach the plugin", func() bool { return greet()["team"] == "core" })

	// Its KV, from its process and from its web part.
	raw, err = call("hello.remember", false, map[string]string{"thread": "t1", "value": "kept"})
	if err != nil || string(raw) != `"kept"` {
		t.Fatalf("remember: %s %v", raw, err)
	}
	raw, err = call("plugins.kv.get", false, map[string]string{"plugin": "hello", "scope": "thread:t1", "key": "x"})
	if err != nil || !strings.Contains(string(raw), `"kept"`) {
		t.Errorf("kv from the web: %s %v", raw, err)
	}
	if _, err := call("plugins.kv.set", false, map[string]any{"plugin": "hello", "scope": "settings", "key": "greeting", "value": "x"}); err == nil {
		t.Error("the web part wrote settings through kv")
	}
	changed := false
	for _, e := range c.Broadcasts() {
		if ev, ok := e.(plugin.KVChangedEvent); ok && ev.Event == "hello.kv.changed" && ev.Scope == "thread:t1" {
			changed = true
		}
	}
	if !changed {
		t.Error("no hello.kv.changed event")
	}
}

// The SDK's example plugins install as they are.
func TestExampleManifests(t *testing.T) {
	dirs, _ := filepath.Glob("../../../sdk/plugin/example/*")
	if len(dirs) == 0 {
		t.Fatal("no example plugins found")
	}
	for _, dir := range dirs {
		if _, err := external.ReadManifest(dir); err != nil {
			t.Errorf("%s: %v", filepath.Base(dir), err)
		}
	}
}
