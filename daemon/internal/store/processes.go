package store

import (
	"database/sql"
	"errors"
)

// Process is a processes row. Spec, Snapshot and Prev are JSON the process
// package owns.
type Process struct {
	ID            string
	ThreadID      string
	AgentThreadID string // the claude thread or tab that started it, if any
	Name          string
	Command       string
	Cwd           string
	Spec          []byte
	Status        string
	ExitCode      *int
	StartedAt     int64
	EndedAt       *int64
	Snapshot      []byte
	Prev          []byte
}

const processColumns = `id, thread_id, COALESCE(agent_thread_id, ''), name, command, cwd, spec,
status, exit_code, started_at, ended_at, snapshot, prev`

func scanProcess(sc interface{ Scan(...any) error }) (Process, error) {
	var p Process
	var exit, ended sql.NullInt64
	err := sc.Scan(&p.ID, &p.ThreadID, &p.AgentThreadID, &p.Name, &p.Command, &p.Cwd, &p.Spec,
		&p.Status, &exit, &p.StartedAt, &ended, &p.Snapshot, &p.Prev)
	if exit.Valid {
		code := int(exit.Int64)
		p.ExitCode = &code
	}
	if ended.Valid {
		p.EndedAt = &ended.Int64
	}
	return p, err
}

// ListProcesses returns a thread's processes, most recently started first.
func (s *Store) ListProcesses(threadID string) ([]Process, error) {
	rows, err := s.db.Query("SELECT "+processColumns+" FROM processes WHERE thread_id = ? ORDER BY started_at DESC", threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Process{}
	for rows.Next() {
		p, err := scanProcess(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ProcessIDs returns the ids of every process, for finding stray logs.
func (s *Store) ProcessIDs() (map[string]bool, error) {
	rows, err := s.db.Query("SELECT id FROM processes")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

func (s *Store) GetProcess(id string) (Process, error) {
	p, err := scanProcess(s.db.QueryRow("SELECT "+processColumns+" FROM processes WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrNotFound
	}
	return p, err
}

// SaveProcess inserts or replaces a process row.
func (s *Store) SaveProcess(p Process) error {
	var agent any
	if p.AgentThreadID != "" {
		agent = p.AgentThreadID
	}
	_, err := s.db.Exec(`
INSERT INTO processes (id, thread_id, agent_thread_id, name, command, cwd, spec, status, exit_code, started_at, ended_at, snapshot, prev)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
  agent_thread_id = excluded.agent_thread_id, command = excluded.command, cwd = excluded.cwd,
  spec = excluded.spec, status = excluded.status, exit_code = excluded.exit_code,
  started_at = excluded.started_at, ended_at = excluded.ended_at,
  snapshot = excluded.snapshot, prev = excluded.prev`,
		p.ID, p.ThreadID, agent, p.Name, p.Command, p.Cwd, p.Spec, p.Status, p.ExitCode,
		p.StartedAt, p.EndedAt, p.Snapshot, p.Prev)
	return err
}

func (s *Store) DeleteProcess(id string) error {
	return s.execOne("DELETE FROM processes WHERE id = ?", id)
}

// MarkProcessesLost ends the processes a previous daemon was running when
// it went away; trackers have no process, so they carry on.
func (s *Store) MarkProcessesLost() error {
	_, err := s.db.Exec("UPDATE processes SET status = 'lost', ended_at = ? WHERE status = 'running' AND command != ''", now())
	return err
}

// NewProcessID makes an id for a new process.
func NewProcessID() string { return newID() }
