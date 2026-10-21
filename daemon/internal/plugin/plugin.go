// Package plugin is the daemon's plugin API: what a feature registers
// (control methods, data channels, WebRTC sessions, thread and tab kinds,
// MCP tools for claude, contributions to claude's launch) and the host
// services it gets in return (the store, threads, events, other plugins'
// services). Built-in features are plugins on this API; external plugins
// (internal/plugin/external) reach the same registry over JSON-RPC.
//
// See PLUGINS.md for the design.
package plugin

import (
	"context"
	"encoding/json"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

// API is the plugin API revision. A plugin built for another one is
// refused.
const API = 1

// Plugin is one feature.
type Plugin interface {
	Manifest() Manifest
	// Start registers the plugin's contributions and starts its work.
	// Plugins start in dependency order (Requires, then Optional); one that
	// fails to start is logged and left out, and the others carry on.
	Start(h Host) error
	// Stop stops its work. Plugins stop in reverse start order.
	Stop()
}

// Manifest describes a plugin. What it registers in Start is added to its
// Contributes, so device.info reports what it actually serves.
type Manifest struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Version string `json:"version,omitempty"`
	API     int    `json:"api"`
	// Builtin: compiled into the daemon (and trusted).
	Builtin bool `json:"builtin,omitempty"`
	// Requires lists plugins that must be present and started first;
	// Optional, plugins used when present.
	Requires []string `json:"requires,omitempty"`
	Optional []string `json:"optional,omitempty"`
	// Permissions are what the plugin uses of the host (see PLUGINS.md).
	// Built-ins declare them for the record; external plugins are held to them.
	Permissions []string `json:"permissions,omitempty"`
	// Web: an external plugin with a web part built on the device.
	Web bool `json:"web,omitempty"`
	// Settings, SettingsPage and UI: see protocol.PluginInfo.
	Settings     []protocol.PluginSetting `json:"settings,omitempty"`
	SettingsPage bool                     `json:"settingsPage,omitempty"`
	UI           *protocol.PluginUI       `json:"ui,omitempty"`
	// Icon: see protocol.PluginInfo.
	Icon string `json:"icon,omitempty"`
	// Features are the device features (protocol.Feature*) this plugin
	// stands for, reported in device.info for web apps from before plugins.
	Features []string `json:"-"`

	Contributes Contributes `json:"contributes"`
}

// Contributes is what a plugin serves, filled in as it registers.
type Contributes = protocol.PluginContributes

// Info is the manifest as device.info reports it.
func (m Manifest) Info() protocol.PluginInfo {
	return protocol.PluginInfo{
		ID: m.ID, Title: m.Title, Version: m.Version, API: m.API, Builtin: m.Builtin,
		Requires: m.Requires, Optional: m.Optional, Permissions: m.Permissions,
		Contributes: m.Contributes, Web: m.Web,
		Settings: m.Settings, SettingsPage: m.SettingsPage, UI: m.UI, Icon: m.Icon,
	}
}

// Permissions.
const (
	PermFSRead      = "fs.read"
	PermFSWrite     = "fs.write"
	PermExec        = "exec"
	PermPTY         = "pty"
	PermNetLoopback = "net.loopback"
	PermAgentTools  = "agent.tools"
	PermAgentNotify = "agent.notify"
	PermAgentRead   = "agent.read"
	PermAgentLaunch = "agent.launch"
	PermBrowser     = "browser"
	// PermScreen needs consent on the device itself (see LocalConsent).
	PermScreen  = "screen"
	PermSecrets = "secrets"
	PermRemote  = "remote"
)

// LocalConsent lists permissions that can only be granted on the device
// (its CLI), never from the web app or the hub.
var LocalConsent = []string{PermScreen}

// Host is what a plugin registers with and uses. Each plugin gets its own.
type Host interface {
	// ID is the plugin's id.
	ID() string

	// HandleRPC serves a control method, over the device connection's
	// control channel and, with Remote, over the hub.
	HandleRPC(method string, fn RPCFunc, opts ...RPCOption)
	// HandleChannel serves data channels whose label starts with prefix.
	HandleChannel(prefix string, fn ChannelFunc)
	// HandleSession serves rtc.open sessions of a kind: a PeerConnection of
	// their own, signaled over the control channel (see Session).
	HandleSession(kind string, h SessionHandler)
	// AddKind registers a thread or tab kind.
	AddKind(k KindHandler)
	// AddTools adds tools to the daemon's MCP server for claude threads.
	AddTools(tools ...Tool)
	// ContributeAgent adds to every claude process the agent plugin starts.
	ContributeAgent(fn func(AgentLaunch) AgentContribution)
	// DecorateThread fills a thread's live fields (running, counts) when
	// it's listed.
	DecorateThread(fn func(t *protocol.Thread))

	// Export makes a service available to other plugins under name.
	Export(name string, svc any)
	// Service finds another plugin's exported service.
	Service(name string) (any, bool)

	// Emit sends an event to every connected browser.
	Emit(event any)
	// Notify sends a notification through the hub (push and in-app alerts).
	// Only names travel, never content; it's dropped while the hub is down.
	Notify(n protocol.HubNotify)
	// Bus is the in-daemon event bus.
	Bus() *Bus

	// Store is the daemon's database (built-ins only).
	Store() *store.Store
	// KV is the plugin's own key/value state.
	KV() KV
	// Threads resolves threads and where they work.
	Threads() Threads
	// Info is the device's info.
	Info() protocol.DeviceInfo
	// DataDir is the daemon's data directory; plugins keep their files in
	// it (built-ins at their historic paths, others under plugins/<id>).
	DataDir() string
	// WebRTC gives what a plugin needs to make PeerConnections of its own.
	WebRTC() WebRTC
	// Tools is the daemon's MCP server, for granting claude processes access.
	Tools() ToolServer
	// Config reads device-local settings.
	Config() Config
	// AgentContributions collects every plugin's contribution to a claude launch.
	AgentContributions(l AgentLaunch) AgentContribution
	// Kind finds the handler of a thread or tab kind.
	Kind(kind string) (KindHandler, bool)
	// Plugins lists the started plugins' manifests.
	Plugins() []Manifest
}

// RPCFunc answers a control method.
type RPCFunc func(ctx context.Context, c RPCContext, params json.RawMessage) (any, error)

// RPCContext says who called.
type RPCContext struct {
	// Peer is the browser tab's connection; nil when the call came over the
	// hub (an MCP agent) or from inside the daemon.
	Peer Peer
	// Remote: the call came over the hub.
	Remote bool
}

// RPCOption configures a method.
type RPCOption func(*RPCSpec)

// RPCSpec is a registered method.
type RPCSpec struct {
	Plugin string
	Fn     RPCFunc
	// Slow methods are answered concurrently instead of in order, so they
	// don't hold up the ones behind them.
	Slow bool
	// Remote methods are reachable over the hub (MCP agents). Off by
	// default, so a new method isn't until someone decides it should be.
	Remote bool
	// RemoteOnly methods are only for the hub (e.g. code.*: a browser has
	// terminals and the files tab).
	RemoteOnly bool
}

// Slow answers the method concurrently.
func Slow() RPCOption { return func(s *RPCSpec) { s.Slow = true } }

// Remote makes the method reachable over the hub.
func Remote() RPCOption { return func(s *RPCSpec) { s.Remote = true } }

// RemoteOnly makes the method reachable only over the hub.
func RemoteOnly() RPCOption { return func(s *RPCSpec) { s.Remote, s.RemoteOnly = true, true } }

// Peer is a browser tab's connection to the daemon.
type Peer interface {
	// ID is the connection's signaling id.
	ID() string
	// Client is the hub connection it came from; signing that session out
	// closes it.
	Client() string
	// Send sends an event on its control channel.
	Send(event any)
}

// ChannelContext is a data channel's caller.
type ChannelContext struct {
	Peer Peer
	// Label is the channel's whole label; Rest what follows the prefix.
	Label, Rest string
}

// ChannelFunc serves a data channel. ctx ends when the channel or its
// whole PeerConnection closes (data channel close callbacks aren't
// guaranteed when the connection drops), so cleanup waits on it rather
// than on the channel's OnClose, which the host owns.
type ChannelFunc func(ctx context.Context, c ChannelContext, dc *webrtc.DataChannel)

// Tool is an MCP tool for claude threads.
type Tool struct {
	mcp.Tool
	// Ask: claude asks the user before calling it (it's left out of
	// --allowedTools), as for a tool that runs a command.
	Ask bool
}

// ToolServer is the daemon's MCP server for claude processes.
type ToolServer interface {
	// Grant gives a caller a token; release revokes it.
	Grant(c mcp.Caller) (endpoint, token string, release func(), err error)
	// Allowed lists the tools claude may call without asking.
	Allowed() []string
}

// ToolServerName is the daemon's MCP server as claude knows it; its tools
// show up as mcp__everywhere__<tool>.
const ToolServerName = "everywhere"

// AgentLaunch is a claude process about to start.
type AgentLaunch struct {
	ThreadID  string
	ProjectID string
	// Dir is where it works; Scratch, whether that's a Scratch folder.
	Dir     string
	Scratch bool
}

// AgentContribution is what a plugin adds to a claude launch.
type AgentContribution struct {
	// SystemPrompt is appended to claude's system prompt.
	SystemPrompt []string
	// AllowedTools are allowed without asking (full names).
	AllowedTools []string
	Env          map[string]string
	AddDirs      []string
	// MCPServers are more MCP servers for this claude, by name.
	MCPServers map[string]any
}

// Merge adds o to c.
func (c *AgentContribution) Merge(o AgentContribution) {
	c.SystemPrompt = append(c.SystemPrompt, o.SystemPrompt...)
	c.AllowedTools = append(c.AllowedTools, o.AllowedTools...)
	c.AddDirs = append(c.AddDirs, o.AddDirs...)
	for k, v := range o.Env {
		if c.Env == nil {
			c.Env = map[string]string{}
		}
		c.Env[k] = v
	}
	for k, v := range o.MCPServers {
		if c.MCPServers == nil {
			c.MCPServers = map[string]any{}
		}
		c.MCPServers[k] = v
	}
}

// Threads resolves threads for plugins.
type Threads interface {
	Get(id string) (protocol.Thread, error)
	// Live is Get with the thread's live fields (running, status, counts).
	// Don't call it while holding a lock a plugin's DecorateThread takes.
	Live(id string) (protocol.Thread, error)
	// Workdir is where a thread works: its worktree, Scratch folder or project.
	Workdir(id string) (protocol.Workdir, error)
	// Owner is the thread a thread or tab belongs to (a tab's parent).
	Owner(id string) (string, error)
	// Changed tells browsers the thread list changed.
	Changed()
}

// WebRTC is the core's WebRTC setup, for plugins' own PeerConnections.
type WebRTC interface {
	// SettingEngine is the core's: its interface filter (no container
	// bridges) and ICE timeouts.
	SettingEngine() webrtc.SettingEngine
	// ICEServers are the account's STUN and TURN servers.
	ICEServers() []webrtc.ICEServer
}

// Config is device-local configuration, set with the CLI on the device.
type Config interface {
	// DesktopEnabled: remote desktop was turned on at the device.
	DesktopEnabled() bool
	// PluginEnabled: an external plugin was enabled at the device.
	PluginEnabled(id string) bool
}
