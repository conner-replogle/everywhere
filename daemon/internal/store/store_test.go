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

	for i := range 5 {
		e, err := s.AppendAgentEvent(th.ID, json.RawMessage(fmt.Sprintf(`{"n":%d}`, i)))
		if err != nil || e.Seq != int64(i+1) {
			t.Fatalf("append %d: seq %d, %v", i, e.Seq, err)
		}
	}
	events, truncated, err := s.AgentEvents(th.ID, 1, 2)
	if err != nil || !truncated || len(events) != 2 || events[0].Seq != 4 || events[1].Seq != 5 {
		t.Fatalf("AgentEvents(after 1, limit 2) = %+v truncated=%v %v", events, truncated, err)
	}
	events, truncated, _ = s.AgentEvents(th.ID, 3, 10)
	if truncated || len(events) != 2 || string(events[0].Event) != `{"n":3}` {
		t.Fatalf("AgentEvents(after 3) = %+v truncated=%v", events, truncated)
	}

	if err := s.DeleteThread(th.ID); err != nil {
		t.Fatal(err)
	}
	if events, _, _ := s.AgentEvents(th.ID, 0, 10); len(events) != 0 {
		t.Errorf("events survived thread delete: %d", len(events))
	}
}
