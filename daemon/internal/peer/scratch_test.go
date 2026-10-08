package peer

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

func TestHandoffPrompt(t *testing.T) {
	ev := func(e protocol.AgentEvent) store.AgentEvent {
		b, _ := json.Marshal(e)
		return store.AgentEvent{Event: b}
	}
	events := []store.AgentEvent{
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
	var many []store.AgentEvent
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
	s, projectThread := mcpTestServer(t)
	s.info = protocol.DeviceInfo{Hostname: "laptop", OS: "linux", Arch: "amd64"}
	scratch, err := s.store.ScratchProject()
	if err != nil {
		t.Fatal(err)
	}
	th, err := s.store.CreateThread(scratch.ID, "", protocol.ThreadClaude)
	if err != nil {
		t.Fatal(err)
	}

	// Scratch threads' claude hears where it is; others don't.
	args, release, err := s.claudeArgs(th.ID, scratch.ID)
	if err != nil {
		t.Fatal(err)
	}
	release()
	i := slices.Index(args, "--append-system-prompt")
	if i < 0 || !strings.Contains(args[i+1], th.ScratchDir) || !strings.Contains(args[i+1], "laptop") {
		t.Errorf("scratch args = %q", args)
	}
	args, release, err = s.claudeArgs(projectThread, "")
	if err != nil {
		t.Fatal(err)
	}
	release()
	if slices.Contains(args, "--append-system-prompt") {
		t.Errorf("project thread args = %q", args)
	}

	// Usage counts files per folder, empty folders included.
	empty, _ := s.store.CreateThread(scratch.ID, "", protocol.ThreadTerminal)
	if err := os.WriteFile(filepath.Join(th.ScratchDir, "a.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(th.ScratchDir, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(th.ScratchDir, "sub", "b"), []byte("hi"), 0o600); err != nil {
		t.Fatal(err)
	}
	u, err := s.scratchUsage()
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
	if err := s.removeScratch(scratch.Path); err == nil {
		t.Error("removed the scratch root")
	}
	if err := s.removeScratch(t.TempDir()); err == nil {
		t.Error("removed a folder outside Scratch")
	}
	if err := s.removeScratch(th.ScratchDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(th.ScratchDir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("folder still there: %v", err)
	}
}
