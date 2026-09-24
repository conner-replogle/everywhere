package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestProjectsAndThreads(t *testing.T) {
	s := open(t)
	projects, err := s.ListProjects()
	if err != nil || len(projects) != 1 || !projects[0].IsHome {
		t.Fatalf("want seeded home project, got %+v %v", projects, err)
	}
	home := projects[0]
	if err := s.DeleteProject(home.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("deleting home project: err = %v, want ErrNotFound", err)
	}

	dir := t.TempDir()
	p, err := s.CreateProject(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if p.Name != filepath.Base(dir) {
		t.Errorf("default name = %q", p.Name)
	}
	if _, err := s.CreateProject(dir, "dup"); err == nil {
		t.Error("duplicate path accepted")
	}
	if _, err := s.CreateProject(filepath.Join(dir, "missing"), ""); err == nil {
		t.Error("missing directory accepted")
	}

	th, err := s.CreateThread(p.ID, "", "")
	if err != nil || th.Name != "terminal 1" {
		t.Fatalf("CreateThread = %+v, %v", th, err)
	}
	gotDir, had, err := s.ThreadShell(th.ID)
	if err != nil || gotDir != dir || had {
		t.Fatalf("ThreadShell = %q %v %v", gotDir, had, err)
	}
	if err := s.MarkSpawned(th.ID); err != nil {
		t.Fatal(err)
	}
	if _, had, _ := s.ThreadShell(th.ID); !had {
		t.Error("had_session not set after MarkSpawned")
	}

	// Deleting a project cascades to its threads.
	if err := s.DeleteProject(p.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetThread(th.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("thread survived project delete: %v", err)
	}
}

// A database created before migrations were versioned (user_version 0, V1
// schema) must upgrade in place.
func TestMigratesUnversionedV1Database(t *testing.T) {
	path := filepath.Join(t.TempDir(), "v1.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(migrations[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
INSERT INTO projects (id, name, path, is_home, created_at) VALUES ('p1', 'home', '/', 1, 1);
INSERT INTO threads (id, project_id, name, created_at) VALUES ('t1', 'p1', 'old', 1);`); err != nil {
		t.Fatal(err)
	}
	db.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	th, err := s.GetThread("t1")
	if err != nil || th.Kind != protocol.ThreadTerminal || th.Name != "old" {
		t.Fatalf("GetThread = %+v, %v", th, err)
	}
	var v int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&v); err != nil || v != len(migrations) {
		t.Fatalf("user_version = %d, %v", v, err)
	}
}

func TestAgentThreads(t *testing.T) {
	s := open(t)
	projects, _ := s.ListProjects()
	home := projects[0]

	term, _ := s.CreateThread(home.ID, "", "")
	if _, err := s.AgentThread(term.ID); err == nil {
		t.Error("AgentThread accepted a terminal thread")
	}
	if _, err := s.CreateThread(home.ID, "", "bogus"); err == nil {
		t.Error("unknown kind accepted")
	}
	th, err := s.CreateThread(home.ID, "", protocol.ThreadClaude)
	if err != nil || th.Name != "claude 1" || th.Kind != protocol.ThreadClaude {
		t.Fatalf("CreateThread = %+v, %v", th, err)
	}

	a, err := s.AgentThread(th.ID)
	if err != nil || a.Dir != home.Path || a.SessionID != "" || a.Model != "" || a.PermissionMode != "default" {
		t.Fatalf("AgentThread = %+v, %v", a, err)
	}
	if err := s.SetAgentSessionID(th.ID, "sess"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentModel(th.ID, "haiku"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentPermissionMode(th.ID, "plan"); err != nil {
		t.Fatal(err)
	}
	if a, _ := s.AgentThread(th.ID); a.SessionID != "sess" || a.Model != "haiku" || a.PermissionMode != "plan" {
		t.Fatalf("after updates: %+v", a)
	}
	if a, _ := s.AgentThread(th.ID); a.Workspace != "local" || a.Worktree != "" || a.Continue || a.Context != nil {
		t.Fatalf("workspace defaults: %+v", a)
	}
	if err := s.SetAgentWorkspace(th.ID, "worktree", "main"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentWorktree(th.ID, "/wt", "everywhere/x"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentContinue(th.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentContext(th.ID, json.RawMessage(`{"used":1}`)); err != nil {
		t.Fatal(err)
	}
	a, _ = s.AgentThread(th.ID)
	if a.Workspace != "worktree" || a.BaseBranch != "main" || a.Worktree != "/wt" || a.Branch != "everywhere/x" ||
		!a.Continue || string(a.Context) != `{"used":1}` {
		t.Fatalf("after workspace updates: %+v", a)
	}
	if !a.Thinking || a.Effort != "" {
		t.Fatalf("effort/thinking defaults: %+v", a)
	}
	if err := s.SetAgentEffort(th.ID, "max"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentThinking(th.ID, false); err != nil {
		t.Fatal(err)
	}
	if a, _ := s.AgentThread(th.ID); a.Effort != "max" || a.Thinking {
		t.Fatalf("after effort/thinking: %+v", a)
	}
	if ids, err := s.AgentThreadsToContinue(); err != nil || len(ids) != 1 || ids[0] != th.ID {
		t.Fatalf("AgentThreadsToContinue = %v, %v", ids, err)
	}

	for i := range 5 {
		e, err := s.AppendAgentEvent(th.ID, json.RawMessage(fmt.Sprintf(`{"n":%d}`, i)))
		if err != nil || e.Seq != int64(i+1) {
			t.Fatalf("append %d: seq %d, %v", i, e.Seq, err)
		}
	}
	events, truncated, err := s.AgentEvents(th.ID, 1, 0, 2)
	if err != nil || !truncated || len(events) != 2 || events[0].Seq != 4 || events[1].Seq != 5 {
		t.Fatalf("AgentEvents(after 1, limit 2) = %+v truncated=%v %v", events, truncated, err)
	}
	events, truncated, _ = s.AgentEvents(th.ID, 3, 0, 10)
	if truncated || len(events) != 2 || string(events[0].Event) != `{"n":3}` {
		t.Fatalf("AgentEvents(after 3) = %+v truncated=%v", events, truncated)
	}
	events, more, _ := s.AgentEvents(th.ID, 0, 4, 2)
	if !more || len(events) != 2 || events[0].Seq != 2 || events[1].Seq != 3 {
		t.Fatalf("AgentEvents(before 4, limit 2) = %+v more=%v", events, more)
	}
	if events, more, _ = s.AgentEvents(th.ID, 0, 3, 10); more || len(events) != 2 || events[0].Seq != 1 {
		t.Fatalf("AgentEvents(before 3) = %+v more=%v", events, more)
	}

	if a, err := s.SetThreadArchived(th.ID, true); err != nil || a.ArchivedAt == nil {
		t.Fatalf("archive: %+v, %v", a, err)
	}
	if got, _ := s.GetThread(th.ID); got.ArchivedAt == nil {
		t.Fatalf("archived thread read back unarchived: %+v", got)
	}
	if a, err := s.SetThreadArchived(th.ID, false); err != nil || a.ArchivedAt != nil {
		t.Fatalf("restore: %+v, %v", a, err)
	}

	if err := s.DeleteThread(th.ID); err != nil {
		t.Fatal(err)
	}
	if events, _, _ := s.AgentEvents(th.ID, 0, 0, 10); len(events) != 0 {
		t.Errorf("events survived thread delete: %d", len(events))
	}
}

func TestTabs(t *testing.T) {
	s := open(t)
	p, err := s.CreateProject(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	th, err := s.CreateThread(p.ID, "", protocol.ThreadClaude)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentWorktree(th.ID, "/wt/x", "everywhere/x"); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{protocol.ThreadTerminal, protocol.ThreadClaude, protocol.ThreadBrowser, protocol.ThreadFiles} {
		if _, err := s.CreateTab(th.ID, kind, ""); err != nil {
			t.Fatalf("CreateTab(%s): %v", kind, err)
		}
	}
	if _, err := s.CreateTab(th.ID, "bogus", ""); err == nil {
		t.Error("unknown kind accepted")
	}
	tabs, err := s.ListTabs(th.ID)
	if err != nil || len(tabs) != 4 {
		t.Fatalf("ListTabs = %d %v", len(tabs), err)
	}
	if _, err := s.CreateTab(tabs[0].ID, protocol.ThreadTerminal, ""); err == nil {
		t.Error("tab of a tab accepted")
	}
	threads, _ := s.ListThreads(p.ID)
	if len(threads) != 1 || threads[0].ID != th.ID {
		t.Errorf("ListThreads includes tabs: %+v", threads)
	}

	// The claude tab shares the thread's worktree; the thread's own isn't shared.
	claudeTab := tabs[1]
	a, err := s.AgentThread(claudeTab.ID)
	if err != nil || a.Workspace != "worktree" || a.Worktree != "/wt/x" || a.Branch != "everywhere/x" || !a.SharedWorktree {
		t.Errorf("claude tab agent = %+v %v", a, err)
	}
	if a, _ := s.AgentThread(th.ID); a.SharedWorktree {
		t.Error("thread's own worktree reported shared")
	}
	if _, wt, err := s.ThreadWorkdir(tabs[0].ID); err != nil || wt != "/wt/x" {
		t.Errorf("terminal tab worktree = %q %v", wt, err)
	}

	if err := s.SetTabState(tabs[3].ID, `{"file":"a"}`); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetThread(tabs[3].ID); got.TabState != `{"file":"a"}` || got.ParentID != th.ID {
		t.Errorf("tab = %+v", got)
	}
	if err := s.SetTabState(th.ID, "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("SetTabState on a thread: %v", err)
	}

	if err := s.DeleteThread(th.ID); err != nil {
		t.Fatal(err)
	}
	if tabs, _ := s.ListTabs(th.ID); len(tabs) != 0 {
		t.Errorf("tabs survive their thread: %+v", tabs)
	}
}

func TestSearchAgentEvents(t *testing.T) {
	s := open(t)
	home, _ := s.ListProjects()
	a, _ := s.CreateThread(home[0].ID, "deploy pipeline", protocol.ThreadClaude)
	b, _ := s.CreateThread(home[0].ID, "", protocol.ThreadClaude)
	for _, ev := range []string{
		`{"type":"user","id":"1","text":"Why is the Frobnicator slow?"}`,
		`{"type":"tool","id":"2","name":"Bash","input":{"command":"frobnicator"}}`,
		`{"type":"assistant","id":"3","text":"The frobnicator takes 100%_ of CPU"}`,
	} {
		if _, err := s.AppendAgentEvent(b.ID, json.RawMessage(ev)); err != nil {
			t.Fatal(err)
		}
	}

	hits, err := s.SearchAgentEvents("FROBNICATOR", 10)
	if err != nil || len(hits) != 1 || hits[0].ThreadID != b.ID {
		t.Fatalf("hits = %+v, %v", hits, err)
	}
	if hits[0].Snippet != "The frobnicator takes 100%_ of CPU" {
		t.Errorf("snippet = %q (want the newest match)", hits[0].Snippet)
	}
	if hits, _ := s.SearchAgentEvents("deploy", 10); len(hits) != 1 || hits[0].ThreadID != a.ID || hits[0].Snippet != "" {
		t.Errorf("name search = %+v", hits)
	}
	// A claude tab's messages find its thread.
	tab, err := s.CreateTab(a.ID, protocol.ThreadClaude, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendAgentEvent(tab.ID, json.RawMessage(`{"type":"assistant","id":"4","text":"zebra crossing"}`)); err != nil {
		t.Fatal(err)
	}
	if hits, _ := s.SearchAgentEvents("zebra", 10); len(hits) != 1 || hits[0].ThreadID != a.ID {
		t.Errorf("tab search = %+v", hits)
	}
	// LIKE wildcards in the query are literal.
	if hits, _ := s.SearchAgentEvents("100%_", 10); len(hits) != 1 {
		t.Errorf("literal %%_ = %+v", hits)
	}
	if hits, _ := s.SearchAgentEvents("0_o", 10); len(hits) != 0 {
		t.Errorf("_ matched as a wildcard: %+v", hits)
	}
}
