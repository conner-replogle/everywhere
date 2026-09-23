package store

import (
	"errors"
	"path/filepath"
	"testing"
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

	th, err := s.CreateThread(p.ID, "")
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
