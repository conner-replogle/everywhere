package scratch

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin/plugintest"
	agentplugin "github.com/conner-replogle/everywhere/daemon/internal/plugins/agent"
	browserplugin "github.com/conner-replogle/everywhere/daemon/internal/plugins/browser"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

func TestHandoffPrompt(t *testing.T) {
	ev := func(e protocol.AgentEvent) json.RawMessage {
		b, _ := json.Marshal(e)
		return b
	}
	events := []json.RawMessage{
		ev(protocol.AgentEvent{Type: "user", Text: "why is my disk full?"}),
		ev(protocol.AgentEvent{Type: "tool", Name: "Bash"}),
		ev(protocol.AgentEvent{Type: "assistant", Text: "Docker images take 40 GB.", ParentID: "sub"}),
		ev(protocol.AgentEvent{Type: "assistant", Text: "Mostly Docker images."}),
		ev(protocol.AgentEvent{Type: "user", Text: "/recap"}),
		ev(protocol.AgentEvent{Type: "assistant", Text: strings.Repeat("x", 5000)}),
	}
	got := handoffPrompt("Disk full", "/data/scratch/2026-10-07-abc", events)
	for _, want := range []string{`"Disk full"`, "/data/scratch/2026-10-07-abc", "User: why is my disk full?", "Claude: Mostly Docker images.", " […]"} {
		if !strings.Contains(got, want) {
			t.Errorf("prompt lacks %q:\n%s", want, got)
		}
	}
	for _, unwanted := range []string{"40 GB", "/recap", "left out"} {
		if strings.Contains(got, unwanted) {
			t.Errorf("prompt has %q", unwanted)
		}
	}

	// A long conversation keeps its newest messages.
	var many []json.RawMessage
	for i := range 100 {
		many = append(many, ev(protocol.AgentEvent{Type: "user", Text: strings.Repeat("y", 400) + string(rune('a'+i%26))}))
	}
	many = append(many, ev(protocol.AgentEvent{Type: "assistant", Text: "the newest"}))
	got = handoffPrompt("x", "/d", many)
	if !strings.Contains(got, "the newest") || !strings.Contains(got, "messages are left out") || len(got) > handoffMax+2000 {
		t.Errorf("long handoff: %d bytes", len(got))
	}
}

func TestScratchThreads(t *testing.T) {
	sp, ap := New(), agentplugin.New()
	_, c := plugintest.Start(t, sp, ap, browserplugin.New())
	proj, err := c.St.CreateProject(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	pt, err := c.St.CreateThread(proj.ID, "", protocol.ThreadClaude)
	if err != nil {
		t.Fatal(err)
	}
	projectThread := pt.ID
	scratch, err := c.St.ScratchProject()
	if err != nil {
		t.Fatal(err)
	}
	th, err := c.St.CreateThread(scratch.ID, "", protocol.ThreadClaude)
	if err != nil {
		t.Fatal(err)
	}

	// Scratch threads' claude hears where it is; others don't.
	args, release, err := ap.ClaudeArgs(th.ID, scratch.ID)
	if err != nil {
		t.Fatal(err)
	}
	release()
	i := slices.Index(args, "--append-system-prompt")
	if i < 0 || !strings.Contains(args[i+1], th.ScratchDir) || !strings.Contains(args[i+1], "laptop") {
		t.Errorf("scratch args = %q", args)
	}
	args, release, err = ap.ClaudeArgs(projectThread, "")
	if err != nil {
		t.Fatal(err)
	}
	release()
	if slices.Contains(args, "--append-system-prompt") {
		t.Errorf("project thread args = %q", args)
	}

	// Usage counts files per folder, empty folders included.
	empty, _ := c.St.CreateThread(scratch.ID, "", protocol.ThreadTerminal)
	if err := os.WriteFile(filepath.Join(th.ScratchDir, "a.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(th.ScratchDir, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(th.ScratchDir, "sub", "b"), []byte("hi"), 0o600); err != nil {
		t.Fatal(err)
	}
	u, err := sp.usage()
	if err != nil {
		t.Fatal(err)
	}
	if u.Files != 2 || u.Bytes != 7 || u.Folders[th.ScratchDir] != (protocol.ScratchSize{Files: 2, Bytes: 7}) {
		t.Errorf("usage = %+v", u)
	}
	if _, ok := u.Folders[empty.ScratchDir]; !ok {
		t.Errorf("empty folder missing from %+v", u.Folders)
	}

	// Removing only ever touches thread folders in Scratch.
	if err := sp.remove(scratch.Path); err == nil {
		t.Error("removed the scratch root")
	}
	if err := sp.remove(t.TempDir()); err == nil {
		t.Error("removed a folder outside Scratch")
	}
	if err := sp.remove(th.ScratchDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(th.ScratchDir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("folder still there: %v", err)
	}
}

// fakeAgent is a plugin with an agent thread kind that records its threads'
// first prompts.
type fakeAgent struct{ prompts map[string]string }

func (f *fakeAgent) Manifest() plugin.Manifest {
	return plugin.Manifest{ID: "fake", Title: "Fake", API: plugin.API, Builtin: true}
}

func (f *fakeAgent) Start(h plugin.Host) error {
	h.AddKind(plugin.KindHandler{
		Kind: plugin.Kind{Kind: "fake.agent", Thread: true, View: "agent"},
		Created: func(t protocol.Thread, c plugin.CreateParams) error {
			f.prompts[t.ID] = c.Prompt
			return nil
		},
	})
	return nil
}

func (f *fakeAgent) Stop() {}

func TestProjectTools(t *testing.T) {
	sp, fake := New(), &fakeAgent{prompts: map[string]string{}}
	plugintest.Start(t, sp, agentplugin.New(), fake)
	call := func(name string, args any) (*mcp.Result, error) {
		t.Helper()
		b, _ := json.Marshal(args)
		for _, tool := range sp.tools() {
			if tool.Name == name {
				return tool.Call(context.Background(), mcp.Caller{}, b)
			}
		}
		t.Fatalf("no tool %s", name)
		return nil, nil
	}

	// A missing folder is made, and becomes a project once.
	dir := filepath.Join(t.TempDir(), "solid-craft")
	res, err := call("project_create", map[string]string{"path": dir, "name": "Solid Craft"})
	if err != nil {
		t.Fatal(err)
	}
	var proj protocol.Project
	if err := json.Unmarshal([]byte(res.Content[0].Text), &proj); err != nil || proj.Name != "Solid Craft" {
		t.Fatalf("project = %+v, %v", proj, err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := call("project_create", map[string]string{"path": dir}); err == nil {
		t.Error("made a folder a project twice")
	}
	if res, err = call("projects_list", struct{}{}); err != nil || !strings.Contains(res.Content[0].Text, proj.ID) {
		t.Errorf("projects_list = %v, %v", res, err)
	}
	// Without the clone plugin, there's no cloning.
	if _, err := call("project_create", map[string]string{"path": t.TempDir(), "url": "https://example.com/x.git"}); err == nil {
		t.Error("cloned without the clone plugin")
	}

	// A thread starts with its prompt.
	res, err = call("thread_start", map[string]string{"projectId": proj.ID, "kind": "fake.agent", "prompt": "add image resizing"})
	if err != nil {
		t.Fatal(err)
	}
	var th protocol.Thread
	if err := json.Unmarshal([]byte(res.Content[0].Text), &th); err != nil || th.ProjectID != proj.ID {
		t.Fatalf("thread = %+v, %v", th, err)
	}
	if fake.prompts[th.ID] != "add image resizing" {
		t.Errorf("prompts = %v", fake.prompts)
	}

	for _, bad := range []map[string]string{
		{"projectId": proj.ID, "prompt": ""},
		{"projectId": proj.ID, "prompt": "x", "kind": protocol.ThreadTerminal},
		{"projectId": proj.ID, "prompt": "x", "permissionMode": "bypassPermissions"},
		{"projectId": proj.ID, "prompt": "x", "kind": "fake.agent", "permissionMode": "plan"},
		{"projectId": "nope", "prompt": "x", "kind": "fake.agent"},
	} {
		if _, err := call("thread_start", bad); err == nil {
			t.Errorf("thread_start %v worked", bad)
		}
	}
}
