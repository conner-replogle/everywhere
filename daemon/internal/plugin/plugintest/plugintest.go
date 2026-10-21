// Package plugintest hosts plugins for tests: a registry on a real store in
// a temporary directory, with events collected instead of sent.
package plugintest

import (
	"path/filepath"
	"sync"
	"testing"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

// Core is a test core.
type Core struct {
	St   *store.Store
	Dir  string
	Dev  protocol.DeviceInfo
	Desk bool

	mu       sync.Mutex
	Events   []any
	Notified []protocol.HubNotify
}

func (c *Core) Store() *store.Store       { return c.St }
func (c *Core) Info() protocol.DeviceInfo { return c.Dev }
func (c *Core) DataDir() string           { return c.Dir }
func (c *Core) Threads() plugin.Threads   { return plugin.StoreThreads{Store: c.St} }
func (c *Core) WebRTC() plugin.WebRTC     { return webRTC{} }
func (c *Core) Config() plugin.Config     { return config{c} }

func (c *Core) Broadcast(event any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Events = append(c.Events, event)
}

// Broadcasts returns what was broadcast so far.
func (c *Core) Broadcasts() []any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]any(nil), c.Events...)
}

func (c *Core) Notify(n protocol.HubNotify) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Notified = append(c.Notified, n)
}

type webRTC struct{}

func (webRTC) SettingEngine() webrtc.SettingEngine { return webrtc.SettingEngine{} }
func (webRTC) ICEServers() []webrtc.ICEServer      { return nil }

type config struct{ c *Core }

func (c config) DesktopEnabled() bool      { return c.c.Desk }
func (c config) PluginEnabled(string) bool { return false }

// Start starts plugins on a fresh store and registry, stopped when the
// test ends.
func Start(t *testing.T, plugins ...plugin.Plugin) (*plugin.Registry, *Core) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	c := &Core{St: st, Dir: dir, Dev: protocol.DeviceInfo{Hostname: "laptop", OS: "linux", Arch: "amd64"}}
	r := plugin.NewRegistry("everywhere", "test", plugins...)
	r.Core(c)
	r.Start(c)
	t.Cleanup(func() {
		r.Stop()
		st.Close()
	})
	return r, c
}
