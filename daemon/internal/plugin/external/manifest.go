// Package external hosts plugins installed on the device: each is a
// directory with a plugin.json and a program the daemon runs, which speaks
// JSON-RPC 2.0 over stdin/stdout (one message per line). Its contributions
// are declared in plugin.json (so they're known before it starts, and
// shown at install), registered with the registry like a built-in's, and
// forwarded to the process. An optional web part (web/index.tsx) is built
// on the device and runs in the app's sandboxed plugin frame.
//
// See PLUGINS.md and docs in this package's protocol.go.
package external

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// ManifestFile is the manifest's name in a plugin's directory.
const ManifestFile = "plugin.json"

// Manifest is plugin.json.
type Manifest struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Version     string   `json:"version"`
	API         int      `json:"api"`
	Description string   `json:"description,omitempty"`
	Requires    []string `json:"requires,omitempty"`
	Optional    []string `json:"optional,omitempty"`
	// Command runs the plugin: a program in its directory (or on PATH) and
	// its arguments. It starts in the plugin's data directory.
	Command     []string    `json:"command"`
	Permissions []string    `json:"permissions,omitempty"`
	Contributes Contributes `json:"contributes"`
	// Web is the directory of its web part (index.tsx), if it has one.
	Web string `json:"web,omitempty"`
	// Settings are drawn as a form in Settings → Plugins.
	Settings []protocol.PluginSetting `json:"settings,omitempty"`
	// SettingsPage: its web part also has a settings view (usePlugin().view).
	SettingsPage bool `json:"settingsPage,omitempty"`
}

// Contributes is what a plugin declares it serves.
type Contributes struct {
	RPC      []RPC     `json:"rpc,omitempty"`
	Channels []string  `json:"channels,omitempty"`
	Sessions []string  `json:"sessions,omitempty"`
	Tools    []Tool    `json:"tools,omitempty"`
	Kinds    []Kind    `json:"kinds,omitempty"`
	Events   []string  `json:"events,omitempty"`
	Agent    *AgentAdd `json:"agent,omitempty"`
	// UI is drawn by the app in its own places, from the plugin's methods.
	UI *protocol.PluginUI `json:"ui,omitempty"`
}

// RPC is a control method.
type RPC struct {
	Method string `json:"method"`
	Remote bool   `json:"remote,omitempty"`
	Slow   bool   `json:"slow,omitempty"`
}

// Tool is an MCP tool for claude threads.
type Tool struct {
	Name        string          `json:"name"`
	Title       string          `json:"title,omitempty"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	// Ask: claude asks the user before each call.
	Ask      bool `json:"ask,omitempty"`
	ReadOnly bool `json:"readOnly,omitempty"`
}

// Kind is a tab (or thread) kind; its view is the plugin's web part.
type Kind struct {
	Kind   string `json:"kind"`
	Title  string `json:"title"`
	Thread bool   `json:"thread,omitempty"`
	Single bool   `json:"single,omitempty"`
}

// AgentAdd is what the plugin adds to every claude launch.
type AgentAdd struct {
	SystemPrompt string `json:"systemPrompt,omitempty"`
}

var (
	idRe   = regexp.MustCompile(`^[a-z][a-z0-9-]{1,31}$`)
	nameRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,47}$`)
)

// Reserved are ids external plugins can't take: the core's and built-ins'.
var Reserved = []string{plugin.CoreID, "plugins", "terminal", "agent", "browser", "desktop", "files", "processes",
	"telemetry", "dashboards", "scratch", "git", "clone", "code", "share", "done", "web", "everywhere"}

// ToolName is a plugin tool's name on the daemon's MCP server.
func (m Manifest) ToolName(name string) string {
	return strings.ReplaceAll(m.ID, "-", "_") + "_" + name
}

// Validate checks a manifest: namespaced names, and permissions for what it
// declares.
func (m Manifest) Validate() error {
	var errs []error
	bad := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }
	if !idRe.MatchString(m.ID) {
		bad("id %q: use 2-32 lowercase letters, digits and dashes, starting with a letter", m.ID)
	}
	if slices.Contains(Reserved, m.ID) {
		bad("id %q is taken by a built-in plugin", m.ID)
	}
	if m.API != plugin.API {
		bad("built for plugin API %d; this daemon has %d", m.API, plugin.API)
	}
	if strings.TrimSpace(m.Title) == "" {
		bad("give it a title")
	}
	if len(m.Command) == 0 || strings.TrimSpace(m.Command[0]) == "" {
		bad("give a command to run it")
	}
	known := []string{plugin.PermFSRead, plugin.PermFSWrite, plugin.PermExec, plugin.PermPTY, plugin.PermNetLoopback,
		plugin.PermAgentTools, plugin.PermAgentNotify, plugin.PermAgentRead, plugin.PermAgentLaunch, plugin.PermBrowser,
		plugin.PermScreen, plugin.PermSecrets, plugin.PermRemote}
	for _, p := range m.Permissions {
		if !slices.Contains(known, p) {
			bad("unknown permission %q", p)
		}
	}
	has := func(p string) bool { return slices.Contains(m.Permissions, p) }
	for _, r := range m.Contributes.RPC {
		if !strings.HasPrefix(r.Method, m.ID+".") || len(r.Method) <= len(m.ID)+1 {
			bad("method %q: plugin methods start with %q", r.Method, m.ID+".")
		}
		if r.Remote && !has(plugin.PermRemote) {
			bad("method %q is remote: that needs the %q permission", r.Method, plugin.PermRemote)
		}
	}
	for _, c := range m.Contributes.Channels {
		if !strings.HasPrefix(c, m.ID+"/") {
			bad("channel %q: plugin channels start with %q", c, m.ID+"/")
		}
	}
	for _, s := range m.Contributes.Sessions {
		if s != m.ID && !strings.HasPrefix(s, m.ID+".") {
			bad("session kind %q: use %q or start it with %q", s, m.ID, m.ID+".")
		}
	}
	for _, t := range m.Contributes.Tools {
		if !nameRe.MatchString(t.Name) {
			bad("tool %q: use lowercase letters, digits and underscores", t.Name)
		}
		if len(t.InputSchema) == 0 || !json.Valid(t.InputSchema) {
			bad("tool %q needs an inputSchema", t.Name)
		}
	}
	if len(m.Contributes.Tools) > 0 && !has(plugin.PermAgentTools) {
		bad("tools for claude need the %q permission", plugin.PermAgentTools)
	}
	if m.Contributes.Agent != nil && !has(plugin.PermAgentLaunch) {
		bad("adding to claude's launch needs the %q permission", plugin.PermAgentLaunch)
	}
	for _, k := range m.Contributes.Kinds {
		if k.Kind != m.ID && !strings.HasPrefix(k.Kind, m.ID+".") {
			bad("kind %q: use %q or start it with %q", k.Kind, m.ID, m.ID+".")
		}
		if m.Web == "" {
			bad("kind %q needs a web part to show it", k.Kind)
		}
	}
	methods := map[string]bool{}
	for _, r := range m.Contributes.RPC {
		methods[r.Method] = true
	}
	kinds := map[string]bool{}
	for _, k := range m.Contributes.Kinds {
		kinds[k.Kind] = true
	}
	action := func(where string, a protocol.PluginAction) {
		n := 0
		if a.Call != "" {
			n++
			if !methods[a.Call] {
				bad("%s calls %q, which isn't one of its methods", where, a.Call)
			}
		}
		if a.OpenTab != "" {
			n++
			if !kinds[a.OpenTab] {
				bad("%s opens %q, which isn't one of its kinds", where, a.OpenTab)
			}
		}
		if a.Href != "" {
			n++
			if !strings.HasPrefix(a.Href, "https://") && !strings.HasPrefix(a.Href, "http://") {
				bad("%s links to %q: only http(s) links", where, a.Href)
			}
		}
		if n != 1 || strings.TrimSpace(a.Label) == "" {
			bad("%s needs a label and one of call, openTab or href", where)
		}
	}
	if ui := m.Contributes.UI; ui != nil {
		for name, src := range map[string]*protocol.PluginUISource{"ui.sidebar": ui.Sidebar, "ui.threadBadges": ui.ThreadBadges, "ui.threadHeader": ui.ThreadHeader} {
			if src != nil && !methods[src.Method] {
				bad("%s's method %q isn't one of its methods", name, src.Method)
			}
		}
		for i, a := range ui.DeviceMenu {
			action(fmt.Sprintf("ui.deviceMenu[%d]", i), a)
		}
	}
	seen := map[string]bool{}
	for _, st := range m.Settings {
		switch {
		case !nameRe.MatchString(st.Key) || seen[st.Key]:
			bad("setting %q: a unique key of lowercase letters, digits and underscores", st.Key)
		case !slices.Contains([]string{"string", "text", "number", "boolean", "select", "secret"}, st.Type):
			bad("setting %q: type is string, text, number, boolean, select or secret", st.Key)
		case st.Type == "select" && len(st.Options) == 0:
			bad("setting %q: a select needs options", st.Key)
		case st.Scope != "" && st.Scope != "device" && st.Scope != "account":
			bad("setting %q: scope is device or account", st.Key)
		case strings.TrimSpace(st.Title) == "":
			bad("setting %q needs a title", st.Key)
		}
		seen[st.Key] = true
		if len(st.Default) > 0 {
			if err := CheckSetting(st, st.Default); err != nil {
				bad("setting %q's default: %v", st.Key, err)
			}
		}
	}
	if m.SettingsPage && m.Web == "" {
		bad("a settings page needs a web part")
	}
	if m.Web != "" && (filepath.IsAbs(m.Web) || strings.Contains(filepath.Clean(m.Web), "..")) {
		bad("web %q must be a directory inside the plugin", m.Web)
	}
	return errors.Join(errs...)
}

// ReadManifest reads and validates dir's plugin.json.
func ReadManifest(dir string) (Manifest, error) {
	var m Manifest
	raw, err := os.ReadFile(filepath.Join(dir, ManifestFile))
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return m, fmt.Errorf("%s: %w", ManifestFile, err)
	}
	if err := m.Validate(); err != nil {
		return m, fmt.Errorf("%s: %w", ManifestFile, err)
	}
	return m, nil
}

// Installed lists the plugins installed under root, by id. Directories
// without a valid manifest are skipped (with their errors).
func Installed(root string) (map[string]Manifest, map[string]error) {
	out, bad := map[string]Manifest{}, map[string]error{}
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(root, e.Name())
		if _, err := os.Stat(filepath.Join(dir, ManifestFile)); err != nil {
			continue
		}
		m, err := ReadManifest(dir)
		switch {
		case err != nil:
			bad[e.Name()] = err
		case m.ID != e.Name():
			bad[e.Name()] = fmt.Errorf("its id is %q but it's installed as %q", m.ID, e.Name())
		default:
			out[m.ID] = m
		}
	}
	return out, bad
}
