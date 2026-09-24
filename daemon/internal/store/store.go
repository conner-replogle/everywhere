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
}

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
	if err := migrate(db); err != nil {
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

const threadCols = "id, project_id, kind, name, created_at, last_opened_at, agent_worktree, archived_at, parent_id, tab_state"

func scanThread(sc interface{ Scan(...any) error }) (protocol.Thread, error) {
	var t protocol.Thread
	var opened, archived sql.NullInt64
	var worktree, parent, state sql.NullString
	err := sc.Scan(&t.ID, &t.ProjectID, &t.Kind, &t.Name, &t.CreatedAt, &opened, &worktree, &archived, &parent, &state)
	t.Worktree, t.ParentID, t.TabState = worktree.String, parent.String, state.String
	if opened.Valid {
		t.LastOpenedAt = &opened.Int64
	}
	if archived.Valid {
		t.ArchivedAt = &archived.Int64
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

// CreateThread adds a thread of the given kind ("" means terminal). The name
// defaults to "<kind> N".
func (s *Store) CreateThread(projectID, name, kind string) (protocol.Thread, error) {
	if kind == "" {
		kind = protocol.ThreadTerminal
	}
	if kind != protocol.ThreadTerminal && kind != protocol.ThreadClaude {
		return protocol.Thread{}, fmt.Errorf("unknown thread kind %q", kind)
	}
	if _, err := s.GetProject(projectID); err != nil {
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
	_, err := s.db.Exec("INSERT INTO threads (id, project_id, kind, name, created_at) VALUES (?, ?, ?, ?, ?)",
		t.ID, t.ProjectID, t.Kind, t.Name, t.CreatedAt)
	return t, err
}

// CreateTab opens a tab of the given kind in a thread (not in another tab).
// The name defaults to the kind, capitalized. A claude tab in a thread that runs in a
// worktree shares that worktree.
func (s *Store) CreateTab(threadID, kind, name string) (protocol.Thread, error) {
	switch kind {
	case protocol.ThreadTerminal, protocol.ThreadClaude, protocol.ThreadBrowser, protocol.ThreadFiles:
	default:
		return protocol.Thread{}, fmt.Errorf("unknown tab kind %q", kind)
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
		`SELECT p.path, t.had_session FROM threads t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`,
		threadID,
	).Scan(&dir, &hadSession)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return dir, hadSession, err
}

// ThreadWorkdir is where a thread works: its own worktree (claude), its
// parent's (a tab of a claude thread in a worktree), or the project
// directory. The worktree is "" for the project directory.
func (s *Store) ThreadWorkdir(threadID string) (dir, worktree string, err error) {
	var own, parent sql.NullString
	err = s.db.QueryRow(`
SELECT p.path, t.agent_worktree, par.agent_worktree FROM threads t
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
	_, err := s.db.Exec("UPDATE threads SET had_session = 1, last_opened_at = ? WHERE id = ?", now(), threadID)
	return err
}

// --- agent threads ----------------------------------------------------------

// AgentThread is what the agent manager needs to run a claude thread.
type AgentThread struct {
	ProjectID      string
	Dir            string // the project directory
	SessionID      string // "" until the first turn
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
	var session, model, base, worktree, branch, ctxUsage, effort sql.NullString
	var kind string
	err := s.db.QueryRow(`
SELECT t.project_id, p.path, t.kind, t.agent_session_id, t.agent_model, t.agent_permission_mode,
       t.agent_workspace, t.agent_base_branch, t.agent_worktree, t.agent_branch, t.agent_continue, t.agent_context,
       t.agent_effort, t.agent_thinking, COALESCE(t.agent_worktree = par.agent_worktree, 0)
FROM threads t JOIN projects p ON p.id = t.project_id LEFT JOIN threads par ON par.id = t.parent_id
WHERE t.id = ?`, threadID,
	).Scan(&a.ProjectID, &a.Dir, &kind, &session, &model, &a.PermissionMode,
		&a.Workspace, &base, &worktree, &branch, &a.Continue, &ctxUsage, &effort, &a.Thinking, &a.SharedWorktree)
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	if err == nil && kind != protocol.ThreadClaude {
		return a, fmt.Errorf("thread %s is a %s thread", threadID, kind)
	}
	a.SessionID, a.Model = session.String, model.String
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

func (s *Store) SetAgentSessionID(threadID, sessionID string) error {
	return s.execOne("UPDATE threads SET agent_session_id = ?, last_opened_at = ? WHERE id = ?", sessionID, now(), threadID)
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

// SearchHit is a thread whose name or claude messages contain a query.
type SearchHit struct {
	ThreadID string `json:"threadId"`
	// Snippet is the newest matching message, around the match; empty when
	// only the name matched.
	Snippet string `json:"snippet,omitempty"`
	At      int64  `json:"at"`
}

// SearchAgentEvents finds up to limit threads whose name or prompts and
// replies (in the thread or its claude tabs) contain query
// (case-insensitive), most recently matched first. Tabs aren't hits of
// their own.
func (s *Store) SearchAgentEvents(query string, limit int) ([]SearchHit, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []SearchHit{}, nil
	}
	like := "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(query) + "%"
	rows, err := s.db.Query(`
SELECT thread_id, at, text FROM (
  SELECT id AS thread_id, COALESCE(last_opened_at, created_at) AS at, 0 AS seq, '' AS text
  FROM threads WHERE parent_id IS NULL AND name LIKE ?1 ESCAPE '\'
  UNION ALL
  -- A claude tab's messages count as its thread's.
  SELECT COALESCE(t.parent_id, t.id), e.at, e.seq, json_extract(e.event, '$.text')
  FROM agent_events e JOIN threads t ON t.id = e.thread_id
  WHERE json_extract(e.event, '$.type') IN ('user', 'assistant')
    AND json_extract(e.event, '$.text') LIKE ?1 ESCAPE '\'
)
ORDER BY at DESC, seq DESC LIMIT 1000`, like)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SearchHit{}
	seen := map[string]bool{}
	for rows.Next() {
		var h SearchHit
		var text sql.NullString
		if err := rows.Scan(&h.ThreadID, &h.At, &text); err != nil {
			return nil, err
		}
		if seen[h.ThreadID] {
			continue
		}
		seen[h.ThreadID] = true
		h.Snippet = snippet(text.String, query)
		out = append(out, h)
		if len(out) == limit {
			break
		}
	}
	return out, rows.Err()
}

// snippet is up to about 200 characters of text around query's first match.
func snippet(text, query string) string {
	r := []rune(text)
	i := strings.Index(strings.ToLower(text), strings.ToLower(query))
	if i < 0 {
		i = 0
	}
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
