package peer

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/plugins/builtin"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

func testServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	s := NewServer(st, protocol.DeviceInfo{Hostname: "laptop", OS: "linux", Arch: "amd64", Features: []string{protocol.FeatureTabs}}, dir, builtin.Plugins()...)
	t.Cleanup(func() {
		s.Shutdown()
		st.Close()
	})
	return s
}

func call[T any](t *testing.T, s *Server, remote bool, method string, params any) (T, error) {
	t.Helper()
	var out T
	raw, _ := json.Marshal(params)
	res, err := s.plugins.Call(context.Background(), method, plugin.RPCContext{Remote: remote}, raw)
	if err != nil {
		return out, err
	}
	b, _ := json.Marshal(res)
	return out, json.Unmarshal(b, &out)
}

// Every method from before plugins is still served, and reachable over the
// hub exactly as before: everything but debug.peer, device.update and
// remote desktop; code.*, agent.read and agent.request only there.
func TestMethodsAndRemoteAccess(t *testing.T) {
	s := testServer(t)
	local := []string{
		"device.info", "agent.info", "agent.claudeVersion", "agent.updateClaude", "agent.auth", "agent.login",
		"agent.setToken", "agent.loginCode", "agent.loginCancel", "device.checkUpdate",
		"projects.list", "projects.create", "projects.rename", "projects.clone", "projects.icon", "projects.delete", "clones.list",
		"threads.list", "threads.create", "threads.rename", "threads.done", "threads.archive", "threads.delete", "threads.workdir",
		"threads.search", "threads.promote", "threads.continueIn", "scratch.usage",
		"processes.list", "processes.start", "processes.stop", "processes.restart", "processes.remove",
		"processes.dashboard", "processes.output", "processes.file", "processes.dashboardError", "processes.setState",
		"tabs.list", "tabs.create", "tabs.close", "tabs.setState", "fs.listDirs", "fs.list", "fs.mkdir",
		"git.status", "git.fetch", "git.pull", "git.updateDefault", "git.info",
		"telemetry.catalog", "telemetry.query", "telemetry.events", "telemetry.deleteRun",
		"term.read", "term.write", "threads.get",
	}
	notRemote := []string{"debug.peer", "device.update", "desktop.info", "desktop.start", "desktop.candidate", "desktop.stop", "rtc.open", "rtc.candidate", "rtc.close"}
	remoteOnly := []string{"code.exec", "code.read", "code.write", "code.edit", "code.glob", "code.grep", "agent.read", "agent.request"}

	s.plugins.Manifests() // all started
	registered := map[string]bool{}
	for _, m := range s.plugins.Manifests() {
		for _, r := range m.Contributes.RPC {
			registered[r] = true
		}
	}
	core := []string{"device.info", "device.checkUpdate", "device.update", "debug.peer", "projects.list", "projects.create", "projects.rename",
		"projects.icon", "projects.delete", "threads.list", "threads.get", "threads.create", "threads.rename", "threads.archive", "threads.delete",
		"threads.workdir", "tabs.list", "tabs.create", "tabs.close", "tabs.setState", "fs.listDirs", "fs.mkdir", "rtc.open", "rtc.candidate", "rtc.close"}
	for _, m := range slices.Concat(local, notRemote, remoteOnly) {
		if !registered[m] && !slices.Contains(core, m) {
			t.Errorf("%s isn't registered", m)
		}
	}
	unavailable := func(err error) bool {
		return err != nil && (strings.Contains(err.Error(), "isn't available remotely") || strings.Contains(err.Error(), "unknown method"))
	}
	for _, m := range notRemote {
		if _, err := call[any](t, s, true, m, map[string]any{}); !unavailable(err) {
			t.Errorf("%s over the hub: %v", m, err)
		}
	}
	for _, m := range remoteOnly {
		if _, err := call[any](t, s, false, m, map[string]any{}); err == nil || !strings.Contains(err.Error(), "unknown method") {
			t.Errorf("%s from a browser: %v", m, err)
		}
	}
	for _, m := range []string{"projects.list", "fs.listDirs", "scratch.usage"} {
		if _, err := call[any](t, s, true, m, map[string]any{}); err != nil {
			t.Errorf("%s over the hub: %v", m, err)
		}
	}
}

func TestDeviceInfoListsPlugins(t *testing.T) {
	s := testServer(t)
	info, err := call[protocol.DeviceInfo](t, s, false, "device.info", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{protocol.FeatureTabs, protocol.FeaturePlugins, protocol.FeatureClaude, protocol.FeatureProcesses, protocol.FeatureScratch, protocol.FeatureDone, protocol.FeatureClone, protocol.FeatureGitStatus} {
		if !slices.Contains(info.Features, f) {
			t.Errorf("features lack %s: %v", f, info.Features)
		}
	}
	ids := map[string]protocol.PluginInfo{}
	for _, p := range info.Plugins {
		ids[p.ID] = p
	}
	for _, id := range []string{"terminal", "agent", "browser", "desktop", "files", "processes", "telemetry", "dashboards", "scratch", "git", "clone", "code", "share", "done"} {
		if _, ok := ids[id]; !ok {
			t.Errorf("plugin %s missing from %v", id, info.Plugins)
		}
	}
	if !slices.Contains(ids["processes"].Contributes.Tools, "process_start") ||
		!slices.ContainsFunc(ids["processes"].Contributes.Kinds, func(k protocol.PluginKind) bool { return k.Kind == "processes" && k.Single }) {
		t.Errorf("processes contributes %+v", ids["processes"].Contributes)
	}
}

func TestThreadsAndTabs(t *testing.T) {
	s := testServer(t)
	proj, err := s.store.CreateProject(t.TempDir(), "p")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := call[protocol.Thread](t, s, false, "threads.create", map[string]any{"projectId": proj.ID, "kind": "files"}); err == nil {
		t.Error("made a thread of a tab-only kind")
	}
	if _, err := call[protocol.Thread](t, s, false, "threads.create", map[string]any{"projectId": proj.ID, "kind": "nope"}); err == nil {
		t.Error("made a thread of an unknown kind")
	}
	th, err := call[protocol.Thread](t, s, false, "threads.create", map[string]any{"projectId": proj.ID, "kind": "claude", "permissionMode": "plan"})
	if err != nil {
		t.Fatal(err)
	}
	if a, err := s.store.AgentThread(th.ID); err != nil || a.PermissionMode != "plan" {
		t.Errorf("mode: %+v %v", a, err)
	}
	for _, kind := range []string{"terminal", "claude", "browser", "files", "processes"} {
		if _, err := call[protocol.Thread](t, s, false, "tabs.create", map[string]any{"threadId": th.ID, "kind": kind}); err != nil {
			t.Errorf("tabs.create %s: %v", kind, err)
		}
	}
	tabs, err := call[[]protocol.Thread](t, s, false, "tabs.list", map[string]any{"threadId": th.ID})
	if err != nil || len(tabs) != 5 {
		t.Fatalf("tabs = %v %v", tabs, err)
	}
	if _, err := call[any](t, s, false, "tabs.close", map[string]any{"id": tabs[0].ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := call[any](t, s, false, "threads.archive", map[string]any{"id": th.ID, "archived": true}); err != nil {
		t.Fatal(err)
	}
	if _, err := call[any](t, s, false, "threads.delete", map[string]any{"id": th.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.store.GetThread(tabs[1].ID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("tab survived its thread: %v", err)
	}
}

// Deleting a Scratch thread keeps its folder unless asked; the Scratch
// plugin removes it on the bus.
func TestDeleteScratchFolder(t *testing.T) {
	s := testServer(t)
	scratch, err := s.store.ScratchProject()
	if err != nil {
		t.Fatal(err)
	}
	for _, remove := range []bool{false, true} {
		th, err := call[protocol.Thread](t, s, false, "threads.create", map[string]any{"projectId": scratch.ID, "kind": "terminal"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := call[any](t, s, false, "threads.delete", map[string]any{"id": th.ID, "removeScratch": remove}); err != nil {
			t.Fatal(err)
		}
		_, err = os.Stat(th.ScratchDir)
		if gone := errors.Is(err, os.ErrNotExist); gone != remove {
			t.Errorf("removeScratch %v: folder gone %v", remove, gone)
		}
	}
}
