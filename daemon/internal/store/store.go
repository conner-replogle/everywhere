// Package store persists projects and threads in a local SQLite database.
package store

import (
	"crypto/rand"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("not found")

const schema = `
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL UNIQUE,
  is_home    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_opened_at INTEGER,
  had_session    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS threads_project ON threads(project_id);
`

type Store struct {
	db *sql.DB
}

// Open opens (creating if needed) the database and seeds the home project.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	s := &Store{db: db}
	if err := s.seedHome(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) seedHome() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	var n int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM projects WHERE is_home = 1").Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	_, err = s.db.Exec(
		"INSERT INTO projects (id, name, path, is_home, created_at) VALUES (?, 'home', ?, 1, ?)",
		newID(), home, now(),
	)
	return err
}

// --- projects ---------------------------------------------------------------

func (s *Store) ListProjects() ([]protocol.Project, error) {
	rows, err := s.db.Query("SELECT id, name, path, is_home, created_at FROM projects ORDER BY is_home DESC, name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []protocol.Project{}
	for rows.Next() {
		var p protocol.Project
		if err := rows.Scan(&p.ID, &p.Name, &p.Path, &p.IsHome, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) GetProject(id string) (protocol.Project, error) {
	var p protocol.Project
	err := s.db.QueryRow("SELECT id, name, path, is_home, created_at FROM projects WHERE id = ?", id).
		Scan(&p.ID, &p.Name, &p.Path, &p.IsHome, &p.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrNotFound
	}
	return p, err
}

// CreateProject registers an existing directory. The name defaults to the
// directory's base name.
func (s *Store) CreateProject(path, name string) (protocol.Project, error) {
	path, err := ResolveDir(path)
	if err != nil {
		return protocol.Project{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = filepath.Base(path)
	}
	p := protocol.Project{ID: newID(), Name: name, Path: path, CreatedAt: now()}
	_, err = s.db.Exec("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)",
		p.ID, p.Name, p.Path, p.CreatedAt)
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		return p, fmt.Errorf("%s is already a project", path)
	}
	return p, err
}

func (s *Store) RenameProject(id, name string) (protocol.Project, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return protocol.Project{}, errors.New("name is required")
	}
	if err := s.execOne("UPDATE projects SET name = ? WHERE id = ?", name, id); err != nil {
		return protocol.Project{}, err
	}
	return s.GetProject(id)
}

// DeleteProject removes a project and its threads. The home project can't be deleted.
func (s *Store) DeleteProject(id string) error {
	return s.execOne("DELETE FROM projects WHERE id = ? AND is_home = 0", id)
}

// --- threads ----------------------------------------------------------------

const threadCols = "id, project_id, name, created_at, last_opened_at"

func scanThread(sc interface{ Scan(...any) error }) (protocol.Thread, error) {
	var t protocol.Thread
	var opened sql.NullInt64
	err := sc.Scan(&t.ID, &t.ProjectID, &t.Name, &t.CreatedAt, &opened)
	if opened.Valid {
		t.LastOpenedAt = &opened.Int64
	}
	return t, err
}

// ListThreads lists threads, optionally for one project. Running is left false
// for the caller to fill in.
func (s *Store) ListThreads(projectID string) ([]protocol.Thread, error) {
	q := "SELECT " + threadCols + " FROM threads"
	args := []any{}
	if projectID != "" {
		q += " WHERE project_id = ?"
		args = append(args, projectID)
	}
	rows, err := s.db.Query(q+" ORDER BY created_at", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []protocol.Thread{}
	for rows.Next() {
		t, err := scanThread(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) GetThread(id string) (protocol.Thread, error) {
	t, err := scanThread(s.db.QueryRow("SELECT "+threadCols+" FROM threads WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return t, ErrNotFound
	}
	return t, err
}

func (s *Store) CreateThread(projectID, name string) (protocol.Thread, error) {
	if _, err := s.GetProject(projectID); err != nil {
		return protocol.Thread{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		var n int
		if err := s.db.QueryRow("SELECT COUNT(*) FROM threads WHERE project_id = ?", projectID).Scan(&n); err != nil {
			return protocol.Thread{}, err
		}
		name = fmt.Sprintf("terminal %d", n+1)
	}
	t := protocol.Thread{ID: newID(), ProjectID: projectID, Name: name, CreatedAt: now()}
	_, err := s.db.Exec("INSERT INTO threads (id, project_id, name, created_at) VALUES (?, ?, ?, ?)",
		t.ID, t.ProjectID, t.Name, t.CreatedAt)
	return t, err
}

func (s *Store) RenameThread(id, name string) (protocol.Thread, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return protocol.Thread{}, errors.New("name is required")
	}
	if err := s.execOne("UPDATE threads SET name = ? WHERE id = ?", name, id); err != nil {
		return protocol.Thread{}, err
	}
	return s.GetThread(id)
}

func (s *Store) DeleteThread(id string) error {
	return s.execOne("DELETE FROM threads WHERE id = ?", id)
}

// ThreadShell implements term.Resolver: the directory a thread's shell starts
// in and whether it has had a shell before (so the terminal shows a notice).
func (s *Store) ThreadShell(threadID string) (dir string, hadSession bool, err error) {
	err = s.db.QueryRow(
		`SELECT p.path, t.had_session FROM threads t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`,
		threadID,
	).Scan(&dir, &hadSession)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return dir, hadSession, err
}

// MarkSpawned implements term.Resolver.
func (s *Store) MarkSpawned(threadID string) error {
	_, err := s.db.Exec("UPDATE threads SET had_session = 1, last_opened_at = ? WHERE id = ?", now(), threadID)
	return err
}

// --- helpers ----------------------------------------------------------------

func (s *Store) execOne(q string, args ...any) error {
	res, err := s.db.Exec(q, args...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ResolveDir expands ~, makes the path absolute and checks it is a directory.
func ResolveDir(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, strings.TrimPrefix(path, "~"))
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s is not a directory", abs)
	}
	return abs, nil
}

func now() int64 { return time.Now().UnixMilli() }

func newID() string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}
