// Package store persists projects and threads in a local SQLite database.
package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("not found")

// migrations run in order, each in a transaction; PRAGMA user_version counts
// how many have been applied. Append only: never edit one that has shipped.
var migrations = []string{
	// 1: the V1 schema. Databases from before versioning already have it,
	// hence IF NOT EXISTS.
	`
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
`,
	// 2: agent threads. A thread is a terminal or a Claude conversation; the
	// agent columns are only used by the latter.
	`
ALTER TABLE threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'terminal';
ALTER TABLE threads ADD COLUMN agent_session_id TEXT;
ALTER TABLE threads ADD COLUMN agent_model TEXT;
ALTER TABLE threads ADD COLUMN agent_permission_mode TEXT NOT NULL DEFAULT 'default';
CREATE TABLE agent_events (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  at        INTEGER NOT NULL,
  event     TEXT NOT NULL,
  PRIMARY KEY (thread_id, seq)
) WITHOUT ROWID;
`,
	// 3: where a claude thread runs (the project checkout or its own git
	// worktree), whether it should continue after a daemon update, and its
	// last known context usage.
	`
ALTER TABLE threads ADD COLUMN agent_workspace TEXT NOT NULL DEFAULT 'local';
ALTER TABLE threads ADD COLUMN agent_base_branch TEXT;
ALTER TABLE threads ADD COLUMN agent_worktree TEXT;
ALTER TABLE threads ADD COLUMN agent_branch TEXT;
ALTER TABLE threads ADD COLUMN agent_continue INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN agent_context TEXT;
`,
	// 4: per-thread effort and thinking.
	`
ALTER TABLE threads ADD COLUMN agent_effort TEXT;
ALTER TABLE threads ADD COLUMN agent_thinking INTEGER NOT NULL DEFAULT 1;
`,
	// 5: archived threads.
	`
ALTER TABLE threads ADD COLUMN archived_at INTEGER;
`,
	// 6: tabs. A tab is a thread with a parent: a terminal, claude, browser
	// or files view opened inside another thread. tab_state is the tab's own
	// UI state (the files view's open file).
	`
ALTER TABLE threads ADD COLUMN parent_id TEXT REFERENCES threads(id) ON DELETE CASCADE;
ALTER TABLE threads ADD COLUMN tab_state TEXT;
CREATE INDEX threads_parent ON threads(parent_id);
`,
	// 7: a claude thread rolled back to an earlier message: the transcript
	// entry its next start resumes at, in a fork of its session.
	`
ALTER TABLE threads ADD COLUMN agent_resume_at TEXT;
`,
	// 8: processes a thread runs in the background (see internal/process).
	// spec is how to start it again; snapshot its progress as last saved;
	// prev the previous run's checkpoint timings.
	`
CREATE TABLE processes (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  agent_thread_id TEXT,
  name            TEXT NOT NULL,
  command         TEXT NOT NULL DEFAULT '',
  cwd             TEXT NOT NULL DEFAULT '',
  spec            TEXT,
  status          TEXT NOT NULL,
  exit_code       INTEGER,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  snapshot        TEXT,
  prev            TEXT,
  UNIQUE (thread_id, name)
);
`,
	// 9: Scratch, a project of Everywhere's own (under the data directory)
	// for work outside any project, where each thread gets a folder of its
	// own: scratch_dir.
	`
ALTER TABLE projects ADD COLUMN is_scratch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE threads ADD COLUMN scratch_dir TEXT;
`,
	// 10: threads their agent marked done, until someone touches them again.
	`
ALTER TABLE threads ADD COLUMN done_at INTEGER;
`,
	// Plugins' key/value state: plugin-wide (scope ""), or a thread's or a
	// project's ("thread:<id>", "project:<id>"), deleted with them.
	`
CREATE TABLE plugin_kv (
  plugin     TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT '',
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin, scope, key)
);
CREATE INDEX plugin_kv_scope ON plugin_kv (scope);
`,
	// Pinned threads (always listed, never tucked away), and when a thread
	// was last opened on any device (seen_at, which unlike last_opened_at
	// leaves done_at alone: reading the result isn't working in it).
	`
ALTER TABLE threads ADD COLUMN pinned_at INTEGER;
ALTER TABLE threads ADD COLUMN seen_at INTEGER;
`,
	// Search: the text of every prompt, reply and tool call (its command,
	// path, pattern or URL) in search_docs, kept in step with agent_events by
	// triggers, and a trigram index over it, so any substring of three or
	// more characters is found (as grep would), ranked by bm25.
	`
CREATE TABLE search_docs (
  id        INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  at        INTEGER NOT NULL,
  role      TEXT NOT NULL,
  text      TEXT NOT NULL,
  UNIQUE (thread_id, seq)
);
CREATE VIRTUAL TABLE search_fts USING fts5(
  text, content='search_docs', content_rowid='id', tokenize='trigram remove_diacritics 1'
);
CREATE TRIGGER search_docs_ai AFTER INSERT ON search_docs BEGIN
  INSERT INTO search_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER search_docs_ad AFTER DELETE ON search_docs BEGIN
  INSERT INTO search_fts(search_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE VIEW search_source AS
SELECT thread_id, seq, at,
  json_extract(event, '$.type') AS role,
  CASE json_extract(event, '$.type')
    WHEN 'tool' THEN json_extract(event, '$.name') || ': ' || COALESCE(
      json_extract(event, '$.input.command'), json_extract(event, '$.input.file_path'),
      json_extract(event, '$.input.pattern'), json_extract(event, '$.input.url'),
      json_extract(event, '$.input.query'), json_extract(event, '$.input.description'), '')
    ELSE json_extract(event, '$.text')
  END AS text
FROM agent_events
WHERE json_extract(event, '$.type') IN ('user', 'assistant', 'tool');
CREATE TRIGGER agent_events_search_ai AFTER INSERT ON agent_events
WHEN json_extract(new.event, '$.type') IN ('user', 'assistant', 'tool') BEGIN
  INSERT OR REPLACE INTO search_docs (thread_id, seq, at, role, text)
  SELECT thread_id, seq, at, role, text FROM search_source
  WHERE thread_id = new.thread_id AND seq = new.seq AND COALESCE(text, '') != '';
END;
CREATE TRIGGER agent_events_search_ad AFTER DELETE ON agent_events BEGIN
  DELETE FROM search_docs WHERE thread_id = old.thread_id AND seq = old.seq;
END;
INSERT INTO search_docs (thread_id, seq, at, role, text)
SELECT thread_id, seq, at, role, text FROM search_source WHERE COALESCE(text, '') != '';
`,
}

type Store struct {
	db *sql.DB
	// scratchRoot holds the Scratch project's thread folders.
	scratchRoot string
}

// ScratchDirName is the Scratch project's directory, next to the database.
const ScratchDirName = "scratch"

// Open opens (creating if needed) the database and seeds the home and
// Scratch projects. Scratch lives in ScratchDirName next to the database.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	s := &Store{db: db, scratchRoot: filepath.Join(filepath.Dir(path), ScratchDirName)}
	if err := s.seedHome(); err != nil {
		db.Close()
		return nil, err
	}
	if err := s.seedScratch(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

func migrate(db *sql.DB) error {
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	for i := version; i < len(migrations); i++ {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

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

// seedScratch makes the Scratch project, or points it at the scratch root
// if the data directory moved.
func (s *Store) seedScratch() error {
	if err := os.MkdirAll(s.scratchRoot, 0o700); err != nil {
		return err
	}
	res, err := s.db.Exec("UPDATE projects SET path = ? WHERE is_scratch = 1", s.scratchRoot)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return nil
	}
	_, err = s.db.Exec(
		"INSERT INTO projects (id, name, path, is_scratch, created_at) VALUES (?, 'Scratch', ?, 1, ?)",
		newID(), s.scratchRoot, now(),
	)
	return err
}

// ScratchRoot is where the Scratch project's thread folders are.
func (s *Store) ScratchRoot() string { return s.scratchRoot }

// ScratchProject returns the Scratch project.
func (s *Store) ScratchProject() (protocol.Project, error) {
	return s.scanProject(s.db.QueryRow("SELECT " + projectCols + " FROM projects WHERE is_scratch = 1"))
}

// --- projects ---------------------------------------------------------------

const projectCols = "id, name, path, is_home, is_scratch, created_at"

func (s *Store) scanProject(row *sql.Row) (protocol.Project, error) {
	var p protocol.Project
	err := row.Scan(&p.ID, &p.Name, &p.Path, &p.IsHome, &p.IsScratch, &p.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrNotFound
	}
	return p, err
}

func (s *Store) ListProjects() ([]protocol.Project, error) {
	rows, err := s.db.Query("SELECT " + projectCols + " FROM projects ORDER BY is_home DESC, is_scratch DESC, name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []protocol.Project{}
	for rows.Next() {
		var p protocol.Project
		if err := rows.Scan(&p.ID, &p.Name, &p.Path, &p.IsHome, &p.IsScratch, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) GetProject(id string) (protocol.Project, error) {
	return s.scanProject(s.db.QueryRow("SELECT "+projectCols+" FROM projects WHERE id = ?", id))
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
	if err := s.execOne("UPDATE projects SET name = ? WHERE id = ? AND is_scratch = 0", name, id); err != nil {
		return protocol.Project{}, err
	}
	return s.GetProject(id)
}

// DeleteProject removes a project and its threads. The home and Scratch
// projects can't be deleted.
func (s *Store) DeleteProject(id string) error {
	return s.execOne("DELETE FROM projects WHERE id = ? AND is_home = 0 AND is_scratch = 0", id)
}

// --- threads ----------------------------------------------------------------

const threadCols = "id, project_id, kind, name, created_at, last_opened_at, agent_worktree, archived_at, parent_id, tab_state, scratch_dir, done_at, pinned_at, seen_at"

func scanThread(sc interface{ Scan(...any) error }) (protocol.Thread, error) {
	var t protocol.Thread
	var opened, archived, done, pinned, seen sql.NullInt64
	var worktree, parent, state, scratch sql.NullString
	err := sc.Scan(&t.ID, &t.ProjectID, &t.Kind, &t.Name, &t.CreatedAt, &opened, &worktree, &archived, &parent, &state, &scratch, &done, &pinned, &seen)
	t.Worktree, t.ParentID, t.TabState, t.ScratchDir = worktree.String, parent.String, state.String, scratch.String
	if opened.Valid {
		t.LastOpenedAt = &opened.Int64
	}
	if archived.Valid {
		t.ArchivedAt = &archived.Int64
	}
	if done.Valid {
		t.DoneAt = &done.Int64
	}
	if pinned.Valid {
		t.PinnedAt = &pinned.Int64
	}
	if seen.Valid {
		t.SeenAt = &seen.Int64
	}
	return t, err
}

// ListThreads lists threads, optionally for one project, without their tabs.
// Running is left false for the caller to fill in.
func (s *Store) ListThreads(projectID string) ([]protocol.Thread, error) {
	q := "SELECT " + threadCols + " FROM threads WHERE parent_id IS NULL"
	args := []any{}
	if projectID != "" {
		q += " AND project_id = ?"
		args = append(args, projectID)
	}
	return s.queryThreads(q+" ORDER BY created_at", args...)
}

// ListTabs lists a thread's tabs, oldest first.
func (s *Store) ListTabs(threadID string) ([]protocol.Thread, error) {
	return s.queryThreads("SELECT "+threadCols+" FROM threads WHERE parent_id = ? ORDER BY created_at, rowid", threadID)
}

func (s *Store) queryThreads(q string, args ...any) ([]protocol.Thread, error) {
	rows, err := s.db.Query(q, args...)
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

// validKind reports whether kind can be stored. Which kinds exist is up to
// the plugins that provide them; the caller checks that.
func validKind(kind string) bool {
	if kind == "" || len(kind) > 64 {
		return false
	}
	for _, r := range kind {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.' || r == ':') {
			return false
		}
	}
	return true
}

// CreateThread adds a thread of the given kind ("" means terminal). The name
// defaults to "<kind> N". A thread in Scratch gets a new folder of its own
// there, which it works in; a claude one starts in auto mode.
func (s *Store) CreateThread(projectID, name, kind string) (protocol.Thread, error) {
	if kind == "" {
		kind = protocol.ThreadTerminal
	}
	if !validKind(kind) {
		return protocol.Thread{}, fmt.Errorf("bad thread kind %q", kind)
	}
	project, err := s.GetProject(projectID)
	if err != nil {
		return protocol.Thread{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		var n int
		err := s.db.QueryRow("SELECT COUNT(*) FROM threads WHERE project_id = ? AND kind = ?", projectID, kind).Scan(&n)
		if err != nil {
			return protocol.Thread{}, err
		}
		name = fmt.Sprintf("%s %d", kind, n+1)
	}
	t := protocol.Thread{ID: newID(), ProjectID: projectID, Kind: kind, Name: name, CreatedAt: now()}
	mode := "default"
	if project.IsScratch {
		if t.ScratchDir, err = s.newScratchDir(t.ID, t.CreatedAt); err != nil {
			return protocol.Thread{}, err
		}
		mode = "auto"
	}
	_, err = s.db.Exec(`INSERT INTO threads (id, project_id, kind, name, created_at, scratch_dir, agent_permission_mode)
VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), ?)`,
		t.ID, t.ProjectID, t.Kind, t.Name, t.CreatedAt, t.ScratchDir, mode)
	if err != nil && t.ScratchDir != "" {
		_ = os.Remove(t.ScratchDir)
	}
	return t, err
}

// newScratchDir makes a thread's folder in the scratch root, named for the
// day it was made and the thread: 2026-10-07-a1b2c3d4e5.
func (s *Store) newScratchDir(threadID string, at int64) (string, error) {
	dir := filepath.Join(s.scratchRoot, time.UnixMilli(at).Format("2006-01-02")+"-"+threadID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("making the scratch folder: %w", err)
	}
	return dir, nil
}

// InScratch reports whether path is a thread folder inside the scratch root
// (not the root itself), so it's Everywhere's to delete.
func (s *Store) InScratch(path string) bool {
	rel, err := filepath.Rel(s.scratchRoot, path)
	return err == nil && rel != "." && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel) &&
		!strings.ContainsRune(rel, filepath.Separator)
}

// PromoteThread makes a Scratch thread's folder a project of its own and
// moves the thread (with its tabs) there. Its folder stays where it is, so
// claude carries on in the same directory.
func (s *Store) PromoteThread(threadID, name string) (protocol.Project, error) {
	t, err := s.GetThread(threadID)
	if err != nil {
		return protocol.Project{}, err
	}
	if t.ParentID != "" {
		return protocol.Project{}, errors.New("a tab can't become a project; its thread can")
	}
	if t.ScratchDir == "" {
		return protocol.Project{}, errors.New("only Scratch threads can become a project")
	}
	if strings.TrimSpace(name) == "" {
		name = t.Name
	}
	p, err := s.CreateProject(t.ScratchDir, name)
	if err != nil {
		return p, err
	}
	if _, err := s.db.Exec("UPDATE threads SET project_id = ?1, scratch_dir = NULL WHERE id = ?2 OR parent_id = ?2",
		p.ID, threadID); err != nil {
		_ = s.DeleteProject(p.ID)
		return protocol.Project{}, err
	}
	return p, nil
}

// CreateTab opens a tab of the given kind in a thread (not in another tab).
// The name defaults to the kind, capitalized. A claude tab in a thread that runs in a
// worktree shares that worktree.
func (s *Store) CreateTab(threadID, kind, name string) (protocol.Thread, error) {
	if !validKind(kind) {
		return protocol.Thread{}, fmt.Errorf("bad tab kind %q", kind)
	}
	parent, err := s.GetThread(threadID)
	if err != nil {
		return protocol.Thread{}, err
	}
	if parent.ParentID != "" {
		return protocol.Thread{}, errors.New("tabs can't have tabs")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = strings.ToUpper(kind[:1]) + kind[1:]
	}
	t := protocol.Thread{ID: newID(), ProjectID: parent.ProjectID, ParentID: parent.ID, Kind: kind, Name: name, CreatedAt: now()}
	_, err = s.db.Exec(`
INSERT INTO threads (id, project_id, parent_id, kind, name, created_at, agent_workspace, agent_worktree, agent_branch)
SELECT ?, ?, ?, ?, ?, ?,
       CASE WHEN ? = 'claude' AND agent_worktree IS NOT NULL THEN 'worktree' ELSE 'local' END,
       CASE WHEN ? = 'claude' THEN agent_worktree END,
       CASE WHEN ? = 'claude' THEN agent_branch END
FROM threads WHERE id = ?`,
		t.ID, t.ProjectID, t.ParentID, t.Kind, t.Name, t.CreatedAt, kind, kind, kind, parent.ID)
	if kind == protocol.ThreadClaude && err == nil {
		t.Worktree = parent.Worktree
	}
	return t, err
}

// SetTabState stores a tab's UI state.
func (s *Store) SetTabState(id, state string) error {
	return s.execOne("UPDATE threads SET tab_state = NULLIF(?, '') WHERE id = ? AND parent_id IS NOT NULL", state, id)
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

// SetThreadArchived archives a thread, or restores an archived one.
func (s *Store) SetThreadArchived(id string, archived bool) (protocol.Thread, error) {
	var at any
	if archived {
		at = now()
	}
	if err := s.execOne("UPDATE threads SET archived_at = ? WHERE id = ?", at, id); err != nil {
		return protocol.Thread{}, err
	}
	return s.GetThread(id)
}

// SetThreadDone marks a thread done, or not: for a tab, the thread it
// belongs to.
func (s *Store) SetThreadDone(id string, done bool) error {
	var at any
	if done {
		at = now()
	}
	return s.execOne(`UPDATE threads SET done_at = ?1
WHERE id = (SELECT COALESCE(parent_id, id) FROM threads WHERE id = ?2)`, at, id)
}

// ListLiveThreads lists every thread and tab that isn't archived.
func (s *Store) ListLiveThreads() ([]protocol.Thread, error) {
	return s.queryThreads("SELECT " + threadCols + " FROM threads WHERE archived_at IS NULL")
}

// LastActivity is when someone last used any thread (a prompt, keys typed,
// or opening it), in Unix milliseconds; 0 if never.
func (s *Store) LastActivity() (int64, error) {
	var at sql.NullInt64
	err := s.db.QueryRow(`SELECT MAX(MAX(COALESCE(last_opened_at, 0), COALESCE(seen_at, 0))) FROM threads`).Scan(&at)
	return at.Int64, err
}

// SetThreadPinned pins a thread, or unpins it: for a tab, the thread it
// belongs to. A pinned thread is always listed, whatever its age or doneAt.
func (s *Store) SetThreadPinned(id string, pinned bool) error {
	var at any
	if pinned {
		at = now()
	}
	return s.execOne(`UPDATE threads SET pinned_at = ?1
WHERE id = (SELECT COALESCE(parent_id, id) FROM threads WHERE id = ?2)`, at, id)
}

// SeeThread records a thread (or the thread a tab belongs to) being opened
// on some device, for the sidebar's idle threads. Unlike TouchThread it
// leaves doneAt alone: reading the result isn't working in it.
func (s *Store) SeeThread(id string) error {
	return s.execOne(`UPDATE threads SET seen_at = ?1
WHERE id = (SELECT COALESCE(parent_id, id) FROM threads WHERE id = ?2)`, now(), id)
}

// ReplaceThreadName renames a thread only if its name is still from, so a
// generated name never overwrites one the user chose. It reports whether it
// renamed.
func (s *Store) ReplaceThreadName(id, from, to string) (bool, error) {
	to = strings.TrimSpace(to)
	if to == "" {
		return false, errors.New("name is required")
	}
	res, err := s.db.Exec("UPDATE threads SET name = ? WHERE id = ? AND name = ?", to, id, from)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func (s *Store) DeleteThread(id string) error {
	return s.execOne("DELETE FROM threads WHERE id = ?", id)
}

// ThreadShell implements term.Resolver: the directory a thread's shell starts
// in and whether it has had a shell before (so the terminal shows a notice).
func (s *Store) ThreadShell(threadID string) (dir string, hadSession bool, err error) {
	err = s.db.QueryRow(
		`SELECT `+threadDir+`, t.had_session FROM threads t JOIN projects p ON p.id = t.project_id
LEFT JOIN threads par ON par.id = t.parent_id WHERE t.id = ?`,
		threadID,
	).Scan(&dir, &hadSession)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return dir, hadSession, err
}

// threadDir is the directory a thread (t, with its parent par and project
// p) works in when it has no worktree: its scratch folder, its thread's, or
// the project's.
const threadDir = "COALESCE(t.scratch_dir, par.scratch_dir, p.path)"

// ThreadWorkdir is where a thread works: its own worktree (claude), its
// parent's (a tab of a claude thread in a worktree), its or its parent's
// scratch folder, or the project directory. The worktree is "" otherwise.
func (s *Store) ThreadWorkdir(threadID string) (dir, worktree string, err error) {
	var own, parent sql.NullString
	err = s.db.QueryRow(`
SELECT `+threadDir+`, t.agent_worktree, par.agent_worktree FROM threads t
JOIN projects p ON p.id = t.project_id
LEFT JOIN threads par ON par.id = t.parent_id
WHERE t.id = ?`, threadID,
	).Scan(&dir, &own, &parent)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	worktree = own.String
	if worktree == "" {
		worktree = parent.String
	}
	return dir, worktree, err
}

// MarkSpawned implements term.Resolver.
func (s *Store) MarkSpawned(threadID string) error {
	_, err := s.db.Exec("UPDATE threads SET had_session = 1 WHERE id = ?", threadID)
	return err
}

// TouchThread records someone interacting with a thread (a prompt sent,
// keys typed), and with the thread a tab belongs to, for sorting by recent.
// Either is no longer done: someone is working in it again.
func (s *Store) TouchThread(threadID string) error {
	_, err := s.db.Exec(`UPDATE threads SET last_opened_at = ?1, done_at = NULL
WHERE id = ?2 OR id = (SELECT parent_id FROM threads WHERE id = ?2)`, now(), threadID)
	return err
}

// --- agent threads ----------------------------------------------------------

// AgentThread is what the agent manager needs to run a claude thread.
type AgentThread struct {
	// Kind is the thread's kind: claude, or another agent's.
	Kind      string
	ProjectID string
	Dir       string // the project directory, or the thread's scratch folder
	// Scratch: the thread works in a folder of its own in Scratch.
	Scratch   bool
	SessionID string // "" until the first turn
	// ResumeAt, when set, is where the next start forks SessionID: the
	// conversation was rolled back to it.
	ResumeAt       string
	Model          string // "" means the CLI's default
	PermissionMode string
	// Workspace is "local" (run in Dir) or "worktree" (run in a worktree of
	// Dir's repository, created on the first prompt from BaseBranch, or the
	// current branch when that's empty).
	Workspace  string
	BaseBranch string
	Worktree   string // the worktree's path once created
	Branch     string // the worktree's branch once created
	// Continue asks for the interrupted turn to be continued on startup.
	Continue bool
	Context  json.RawMessage // last known context usage, or nil
	Effort   string          // "" means the model's default
	Thinking bool
	// SharedWorktree means Worktree is the one of the thread this is a tab
	// of, so it stays when the tab closes.
	SharedWorktree bool
}

func (s *Store) AgentThread(threadID string) (AgentThread, error) {
	var a AgentThread
	var session, resumeAt, model, base, worktree, branch, ctxUsage, effort sql.NullString
	err := s.db.QueryRow(`
SELECT t.project_id, `+threadDir+`, p.is_scratch, t.kind, t.agent_session_id, t.agent_resume_at, t.agent_model, t.agent_permission_mode,
       t.agent_workspace, t.agent_base_branch, t.agent_worktree, t.agent_branch, t.agent_continue, t.agent_context,
       t.agent_effort, t.agent_thinking, COALESCE(t.agent_worktree = par.agent_worktree, 0)
FROM threads t JOIN projects p ON p.id = t.project_id LEFT JOIN threads par ON par.id = t.parent_id
WHERE t.id = ?`, threadID,
	).Scan(&a.ProjectID, &a.Dir, &a.Scratch, &a.Kind, &session, &resumeAt, &model, &a.PermissionMode,
		&a.Workspace, &base, &worktree, &branch, &a.Continue, &ctxUsage, &effort, &a.Thinking, &a.SharedWorktree)
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	a.SessionID, a.ResumeAt, a.Model = session.String, resumeAt.String, model.String
	a.BaseBranch, a.Worktree, a.Branch = base.String, worktree.String, branch.String
	a.Effort = effort.String
	if ctxUsage.Valid {
		a.Context = json.RawMessage(ctxUsage.String)
	}
	return a, err
}

// SetAgentWorkspace chooses where a thread runs. It's only meant to change
// before the thread's first prompt.
func (s *Store) SetAgentWorkspace(threadID, workspace, baseBranch string) error {
	return s.execOne("UPDATE threads SET agent_workspace = ?, agent_base_branch = NULLIF(?, '') WHERE id = ?",
		workspace, baseBranch, threadID)
}

// SetAgentWorktree records the worktree created for a thread.
func (s *Store) SetAgentWorktree(threadID, path, branch string) error {
	return s.execOne("UPDATE threads SET agent_worktree = ?, agent_branch = ? WHERE id = ?", path, branch, threadID)
}

func (s *Store) SetAgentContinue(threadID string, cont bool) error {
	return s.execOne("UPDATE threads SET agent_continue = ? WHERE id = ?", cont, threadID)
}

// AgentThreadsToContinue lists threads marked to continue after a restart.
func (s *Store) AgentThreadsToContinue() ([]string, error) {
	rows, err := s.db.Query("SELECT id FROM threads WHERE kind = ? AND agent_continue = 1", protocol.ThreadClaude)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Store) SetAgentEffort(threadID, effort string) error {
	return s.execOne("UPDATE threads SET agent_effort = NULLIF(?, '') WHERE id = ?", effort, threadID)
}

func (s *Store) SetAgentThinking(threadID string, on bool) error {
	return s.execOne("UPDATE threads SET agent_thinking = ? WHERE id = ?", on, threadID)
}

func (s *Store) SetAgentContext(threadID string, usage json.RawMessage) error {
	return s.execOne("UPDATE threads SET agent_context = ? WHERE id = ?", string(usage), threadID)
}

// SetAgentSessionID records the thread's claude session. A new session
// supersedes a pending rollback: it's either the fork that carried it out
// or a fresh start.
func (s *Store) SetAgentSessionID(threadID, sessionID string) error {
	return s.execOne("UPDATE threads SET agent_session_id = NULLIF(?, ''), agent_resume_at = NULL WHERE id = ?",
		sessionID, threadID)
}

// SetAgentResumeAt rolls the thread's conversation back: its next start
// resumes a fork of the session at this transcript entry.
func (s *Store) SetAgentResumeAt(threadID, entry string) error {
	return s.execOne("UPDATE threads SET agent_resume_at = NULLIF(?, '') WHERE id = ?", entry, threadID)
}

func (s *Store) SetAgentModel(threadID, model string) error {
	return s.execOne("UPDATE threads SET agent_model = NULLIF(?, '') WHERE id = ?", model, threadID)
}

func (s *Store) SetAgentPermissionMode(threadID, mode string) error {
	return s.execOne("UPDATE threads SET agent_permission_mode = ? WHERE id = ?", mode, threadID)
}

// AgentEvent is one entry in a claude thread's event log.
type AgentEvent struct {
	Seq   int64
	At    int64
	Event json.RawMessage
}

// AppendAgentEvent adds an event to a thread's log and returns it with its
// sequence number. Callers serialize appends per thread.
func (s *Store) AppendAgentEvent(threadID string, event json.RawMessage) (AgentEvent, error) {
	e := AgentEvent{At: now(), Event: event}
	err := s.db.QueryRow(`
INSERT INTO agent_events (thread_id, seq, at, event)
SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ? FROM agent_events WHERE thread_id = ?
RETURNING seq`, threadID, e.At, string(event), threadID).Scan(&e.Seq)
	return e, err
}

// AgentEvents returns a thread's events after afterSeq and, unless beforeSeq
// is 0, before beforeSeq, oldest first. When more than limit match, it
// returns the newest limit and truncated is true.
func (s *Store) AgentEvents(threadID string, afterSeq, beforeSeq int64, limit int) (events []AgentEvent, truncated bool, err error) {
	if beforeSeq <= 0 {
		beforeSeq = math.MaxInt64
	}
	rows, err := s.db.Query(`
SELECT seq, at, event FROM agent_events WHERE thread_id = ? AND seq > ? AND seq < ?
ORDER BY seq DESC LIMIT ?`, threadID, afterSeq, beforeSeq, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	for rows.Next() {
		var e AgentEvent
		var ev string
		if err := rows.Scan(&e.Seq, &e.At, &ev); err != nil {
			return nil, false, err
		}
		e.Event = json.RawMessage(ev)
		events = append(events, e)
	}
	if len(events) > limit {
		events, truncated = events[:limit], true
	}
	slices.Reverse(events)
	return events, truncated, rows.Err()
}

// AgentPromptSeq returns the seq of the user prompt with the given id in a
// thread's log.
func (s *Store) AgentPromptSeq(threadID, id string) (int64, error) {
	var seq int64
	err := s.db.QueryRow(`
SELECT seq FROM agent_events
WHERE thread_id = ? AND json_extract(event, '$.type') = 'user' AND json_extract(event, '$.id') = ?`,
		threadID, id).Scan(&seq)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return seq, err
}

// DeleteAgentEvents removes the events with fromSeq <= seq < toSeq from a
// thread's log. Later appends still count up from the newest seq left, so
// toSeq must be kept for seqs to never be reused.
func (s *Store) DeleteAgentEvents(threadID string, fromSeq, toSeq int64) error {
	_, err := s.db.Exec("DELETE FROM agent_events WHERE thread_id = ? AND seq >= ? AND seq < ?", threadID, fromSeq, toSeq)
	return err
}

// SearchHit is a thread whose name, or one of whose prompts, replies or tool
// calls (in the thread or its tabs), matches a query.
type SearchHit struct {
	ThreadID string `json:"threadId"`
	// Snippet is the best matching message, around the match; empty when
	// only the name matched.
	Snippet string `json:"snippet,omitempty"`
	// At is when the thread last matched, or was last active when only its
	// name matched.
	At int64 `json:"at"`

	Name        string `json:"name"`
	Kind        string `json:"kind"`
	ProjectID   string `json:"projectId"`
	ProjectName string `json:"projectName"`
	Scratch     bool   `json:"scratch,omitempty"`
	ArchivedAt  *int64 `json:"archivedAt,omitempty"`
	DoneAt      *int64 `json:"doneAt,omitempty"`
	PinnedAt    *int64 `json:"pinnedAt,omitempty"`
	// Role is what the snippet is: user | assistant | tool, or name.
	Role string `json:"role"`
	// TabID is the tab the snippet's message is in, when not the thread
	// itself; Seq is that message's place in its log.
	TabID string `json:"tabId,omitempty"`
	Seq   int64  `json:"seq,omitempty"`
	// Matches counts the thread's matching messages (up to the scan's limit).
	Matches int `json:"matches"`
	// Score orders hits, from any device: higher is better, about 0 to 1.
	Score float64 `json:"score"`
}

// SearchOptions narrows a search.
type SearchOptions struct {
	Limit int
	// ProjectID, when set, keeps to one project's threads.
	ProjectID string
	// SkipArchived leaves archived threads out.
	SkipArchived bool
}

// searchTerms splits a query into terms: "quoted phrases" and words. At
// most 16.
func searchTerms(query string) []string {
	var out []string
	for len(out) < 16 {
		query = strings.TrimLeft(query, " \t\n\r")
		if query == "" {
			break
		}
		var term string
		if query[0] == '"' {
			end := strings.IndexByte(query[1:], '"')
			if end < 0 {
				term, query = query[1:], ""
			} else {
				term, query = query[1:end+1], query[end+2:]
			}
		} else if i := strings.IndexAny(query, " \t\n\r"); i >= 0 {
			term, query = query[:i], query[i:]
		} else {
			term, query = query, ""
		}
		if term = strings.TrimSpace(term); term != "" {
			out = append(out, term)
		}
	}
	return out
}

var likeEscape = strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`)

// maxScan is how many matching messages a search ranks.
const maxScan = 3000

// SearchThreads finds the threads whose name, or one of whose prompts,
// replies or tool calls (a command, path, pattern or URL), contains every
// term of query: a word or a "quoted phrase", case-insensitive, as a
// substring (so "keyr" finds "keyring"). Terms of three characters or more
// go through the trigram index; shorter ones are checked by LIKE. A tab's
// messages count as its thread's. Hits are ranked by how well the best
// message matches (bm25), a match in the name, how many messages match,
// and how recent the thread is.
func (s *Store) SearchThreads(query string, o SearchOptions) ([]SearchHit, error) {
	terms := searchTerms(query)
	if len(terms) == 0 {
		return []SearchHit{}, nil
	}
	var match []string
	var likeArgs []any
	var like []string
	for _, t := range terms {
		if len([]rune(t)) >= 3 {
			match = append(match, `"`+strings.ReplaceAll(t, `"`, `""`)+`"`)
		} else {
			likeArgs = append(likeArgs, "%"+likeEscape.Replace(t)+"%")
			like = append(like, `d.text LIKE ? ESCAPE '\'`)
		}
	}

	// Messages that match, best first (or newest first without the index).
	var q string
	var args []any
	if len(match) > 0 {
		q = `SELECT d.thread_id, d.seq, d.at, d.role, d.text, bm25(search_fts) FROM search_fts
JOIN search_docs d ON d.id = search_fts.rowid WHERE search_fts MATCH ?`
		args = append(args, strings.Join(match, " AND "))
		for _, l := range like {
			q += " AND " + l
		}
		q += " ORDER BY bm25(search_fts), d.at DESC LIMIT ?"
	} else {
		q = `SELECT d.thread_id, d.seq, d.at, d.role, d.text, -1.0 FROM search_docs d WHERE ` +
			strings.Join(like, " AND ") + " ORDER BY d.at DESC LIMIT ?"
	}
	args = append(append(args, likeArgs...), maxScan)

	type msg struct {
		thread string
		seq    int64
		at     int64
		role   string
		text   string
		rel    float64 // higher is better
	}
	var msgs []msg
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var m msg
		var rank float64
		if err := rows.Scan(&m.thread, &m.seq, &m.at, &m.role, &m.text, &rank); err != nil {
			rows.Close()
			return nil, err
		}
		m.rel = -rank
		if m.role == "tool" {
			m.rel *= 0.7 // a command or path is good, words someone wrote better
		}
		msgs = append(msgs, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Every thread and tab, with its project: few enough to read whole.
	type info struct {
		hit    SearchHit
		parent string
		active int64
	}
	infos := map[string]*info{}
	rows, err = s.db.Query(`
SELECT t.id, COALESCE(t.parent_id, ''), t.name, t.kind, t.project_id, p.name, p.is_scratch,
  t.archived_at, t.done_at, t.pinned_at,
  MAX(t.created_at, COALESCE(t.last_opened_at, 0), COALESCE(t.seen_at, 0))
FROM threads t JOIN projects p ON p.id = t.project_id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var i info
		var archived, done, pinned sql.NullInt64
		if err := rows.Scan(&i.hit.ThreadID, &i.parent, &i.hit.Name, &i.hit.Kind, &i.hit.ProjectID, &i.hit.ProjectName,
			&i.hit.Scratch, &archived, &done, &pinned, &i.active); err != nil {
			rows.Close()
			return nil, err
		}
		if archived.Valid {
			i.hit.ArchivedAt = &archived.Int64
		}
		if done.Valid {
			i.hit.DoneAt = &done.Int64
		}
		if pinned.Valid {
			i.hit.PinnedAt = &pinned.Int64
		}
		infos[i.hit.ThreadID] = &i
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	root := func(id string) *info {
		i := infos[id]
		if i != nil && i.parent != "" {
			if p := infos[i.parent]; p != nil {
				return p
			}
		}
		return i
	}
	keep := func(i *info) bool {
		return i != nil && i.parent == "" &&
			(o.ProjectID == "" || i.hit.ProjectID == o.ProjectID) &&
			!(o.SkipArchived && i.hit.ArchivedAt != nil)
	}

	type agg struct {
		info    *info
		best    msg
		rel     float64
		latest  int64
		matches int
		name    float64 // how well the name matched, 0 to 1
	}
	byThread := map[string]*agg{}
	var top float64
	for _, m := range msgs {
		i := root(m.thread)
		if !keep(i) {
			continue
		}
		a := byThread[i.hit.ThreadID]
		if a == nil {
			a = &agg{info: i, best: m, rel: m.rel}
			byThread[i.hit.ThreadID] = a
		} else if m.rel > a.rel || (m.rel == a.rel && m.at > a.best.at) {
			a.best, a.rel = m, m.rel
		}
		a.matches++
		a.latest = max(a.latest, m.at)
		top = max(top, a.rel)
	}
	for _, i := range infos {
		if !keep(i) {
			continue
		}
		lower := strings.ToLower(i.hit.Name)
		all := true
		for _, t := range terms {
			if !strings.Contains(lower, strings.ToLower(t)) {
				all = false
				break
			}
		}
		if !all {
			continue
		}
		a := byThread[i.hit.ThreadID]
		if a == nil {
			a = &agg{info: i}
			byThread[i.hit.ThreadID] = a
		}
		a.name = 0.8
		if strings.HasPrefix(lower, strings.ToLower(terms[0])) {
			a.name = 1
		}
	}

	t := now()
	out := make([]SearchHit, 0, len(byThread))
	for _, a := range byThread {
		h := a.info.hit
		h.Matches = a.matches
		h.At = max(a.latest, a.info.active)
		rel := a.name
		if a.matches > 0 {
			h.Snippet = snippet(a.best.text, terms)
			h.Role, h.Seq = a.best.role, a.best.seq
			if a.best.thread != h.ThreadID {
				h.TabID = a.best.thread
			}
			if top > 0 {
				rel = max(rel, a.rel/top)
			} else {
				rel = max(rel, 0.7)
			}
		} else {
			h.Role = "name"
		}
		days := float64(max(0, t-h.At)) / float64(24*time.Hour/time.Millisecond)
		recency := 1 / (1 + days/14)
		many := math.Min(1, math.Log1p(float64(a.matches))/math.Log1p(10))
		h.Score = 0.6*rel + 0.25*recency + 0.15*many
		if a.name > 0 && a.matches > 0 {
			h.Score = math.Min(1, h.Score+0.1) // name and text both match
		}
		out = append(out, h)
	}
	slices.SortFunc(out, func(a, b SearchHit) int {
		if a.Score != b.Score {
			if a.Score > b.Score {
				return -1
			}
			return 1
		}
		return int(b.At - a.At)
	})
	if o.Limit > 0 && len(out) > o.Limit {
		out = out[:o.Limit]
	}
	return out, nil
}

// SearchAgentEvents is SearchThreads with only a limit, as before.
func (s *Store) SearchAgentEvents(query string, limit int) ([]SearchHit, error) {
	return s.SearchThreads(query, SearchOptions{Limit: limit})
}

// snippet is up to about 200 characters of text around the first term's
// match (or the first term that matches).
func snippet(text string, terms []string) string {
	r := []rune(text)
	lower := strings.ToLower(text)
	i := -1
	// Lowercasing can change byte offsets (a few scripts): then start at the start.
	if len(lower) == len(text) {
		for _, t := range terms {
			if i = strings.Index(lower, strings.ToLower(t)); i >= 0 {
				break
			}
		}
	}
	i = max(i, 0)
	at := len([]rune(text[:i]))
	start := max(0, at-80)
	end := min(len(r), at+120)
	out := strings.Join(strings.Fields(string(r[start:end])), " ")
	if start > 0 {
		out = "…" + out
	}
	if end < len(r) {
		out += "…"
	}
	return out
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
