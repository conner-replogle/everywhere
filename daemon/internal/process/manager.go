// Package process runs the long-lived commands a thread starts in the
// background (dev servers, builds, test runs) on PTYs the daemon owns, and
// tracks their progress: checkpoints, stats and ::ew reports from their
// output. See SPEC.md, Processes.
package process

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	procgroup "github.com/conner-replogle/everywhere/daemon/internal/proc"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
	"github.com/conner-replogle/everywhere/daemon/internal/term"
)

const (
	scrollbackBytes = 1 << 20
	// The log is trimmed to its last logKeep bytes once it reaches logMax.
	logMax  = 64 << 20
	logKeep = 16 << 20
	// A thread keeps this many finished processes.
	keepFinished = 30
	// How often processes.changed may go out per thread.
	changeEvery      = 250 * time.Millisecond
	ptyCols, ptyRows = 120, 32
)

// Who stopped a process.
const (
	byModel  = "model"
	byUser   = "user"
	byDaemon = "daemon"
)

// Store is what the manager keeps in the database; store.Store.
type Store interface {
	ListProcesses(threadID string) ([]store.Process, error)
	GetProcess(id string) (store.Process, error)
	SaveProcess(p store.Process) error
	DeleteProcess(id string) error
	MarkProcessesLost() error
	ProcessIDs() (map[string]bool, error)
}

// Spec is how a process starts; it's kept so it can be restarted.
type Spec struct {
	Command     string            `json:"command,omitempty"`
	Cwd         string            `json:"cwd,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
	Checkpoints []CheckpointSpec  `json:"checkpoints,omitempty"`
	Stats       []StatSpec        `json:"stats,omitempty"`
	// Notify: tell the model when it ends, even if that wakes it.
	Notify bool `json:"notify,omitempty"`
}

// Notice is something the model should hear about.
type Notice struct {
	Name string // the process's
	// Text says what happened, for people; Prompt wraps it for the model.
	Text, Prompt string
	// Wake: the model asked for it, so it may start a turn.
	Wake bool
}

// saved is a process's snapshot column.
type saved struct {
	protocol.Process
	LogBase int64 `json:"logBase,omitempty"`
}

type Manager struct {
	// Workdir is where a thread's processes run unless told otherwise.
	Workdir func(threadID string) (string, error)
	// OnChange is called when a thread's processes change, at most every
	// changeEvery per thread.
	OnChange func(threadID string)
	// OnRunning is called when a process starts or ends.
	OnRunning func()
	// Notify tells the model about something a process did. threadID owns
	// the process; agentThreadID is the claude thread or tab that started
	// it, if one did.
	Notify func(threadID, agentThreadID string, n Notice)

	store Store
	dir   string

	startMu sync.Mutex // one Start at a time, so names stay unique

	mu     sync.Mutex
	live   map[string]*proc // by id: running processes and open trackers
	timers map[string]*time.Timer
	closed bool
}

// NewManager keeps logs in dir. Processes a previous daemon left running
// are marked lost, and logs without a process are removed.
func NewManager(st Store, dir string) *Manager {
	m := &Manager{store: st, dir: dir, live: map[string]*proc{}, timers: map[string]*time.Timer{}}
	if err := st.MarkProcessesLost(); err != nil {
		slog.Warn("marking lost processes", "err", err)
	}
	if ids, err := st.ProcessIDs(); err == nil {
		paths, _ := filepath.Glob(filepath.Join(dir, "*.log"))
		for _, p := range paths {
			if !ids[strings.TrimSuffix(filepath.Base(p), ".log")] {
				_ = os.Remove(p)
			}
		}
	}
	return m
}

type proc struct {
	m             *Manager
	id            string
	threadID      string
	agentThreadID string
	name          string
	spec          Spec
	cwd           string
	started       time.Time
	logPath       string
	prev          []byte // the row's previous timings, until this run ends

	tty   term.TTY // nil for a tracker
	group *procgroup.Group
	done  chan struct{}

	mu         sync.Mutex
	status     string
	exitCode   *int
	endedAt    *int64
	stopping   string // who is stopping it
	prog       *progress
	hide       hideReports
	text       textScanner
	events     []event
	scrollback []byte
	clients    []term.Client
	writer     term.Client
	log        *os.File
	logSize    int64
	logBase    int64 // bytes trimmed off the front of the log
	changed    chan struct{}
	// waiting counts the Wait calls in progress by what they wait for: the
	// tool calls making them report it, so the model isn't told twice.
	waiting map[string]int
}

var nameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,63}$`)

// Start starts a process, or a tracker if spec has no command. A name the
// thread is already running is an error unless replace.
func (m *Manager) Start(threadID, agentThreadID, name string, spec Spec, replace bool) (protocol.Process, error) {
	name = strings.TrimSpace(name)
	if !nameRe.MatchString(name) {
		return protocol.Process{}, fmt.Errorf("name %q: start with a letter or digit; letters, digits, space and ._:- after; at most 64", name)
	}
	for k := range spec.Env {
		if k == "" || strings.ContainsAny(k, "=\x00") {
			return protocol.Process{}, fmt.Errorf("bad environment variable name %q", k)
		}
	}
	m.startMu.Lock()
	defer m.startMu.Unlock()
	if old := m.byName(threadID, name); old != nil {
		if !replace {
			return protocol.Process{}, fmt.Errorf("%q is already running; stop it first or pass replace", name)
		}
		old.stop(byModel)
	}

	rows, err := m.store.ListProcesses(threadID)
	if err != nil {
		return protocol.Process{}, err
	}
	var row store.Process
	for _, r := range rows {
		if r.Name == name {
			row = r
		}
	}
	if row.ID == "" {
		row = store.Process{ID: store.NewProcessID(), ThreadID: threadID, Name: name}
	}
	var prevTimings map[string]int64
	_ = json.Unmarshal(row.Prev, &prevTimings)

	dirFor := threadID
	if agentThreadID != "" {
		dirFor = agentThreadID
	}
	dir, err := m.Workdir(dirFor)
	if err != nil {
		return protocol.Process{}, err
	}
	if spec.Cwd != "" {
		if filepath.IsAbs(spec.Cwd) {
			dir = filepath.Clean(spec.Cwd)
		} else {
			dir = filepath.Join(dir, spec.Cwd)
		}
	}
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		return protocol.Process{}, fmt.Errorf("no such directory: %s", dir)
	}

	now := time.Now()
	prog, err := newProgress(now, spec.Checkpoints, spec.Stats, prevTimings)
	if err != nil {
		return protocol.Process{}, err
	}
	p := &proc{
		m: m, id: row.ID, threadID: threadID, agentThreadID: agentThreadID, name: name,
		spec: spec, cwd: dir, started: now, logPath: filepath.Join(m.dir, row.ID+".log"),
		prev: row.Prev, done: make(chan struct{}), status: protocol.ProcessRunning,
		prog: prog, changed: make(chan struct{}),
	}
	p.text.onLine = p.onLine
	p.text.onOSC = p.prog.oscPayload

	m.mu.Lock()
	closed := m.closed
	m.mu.Unlock()
	if closed {
		return protocol.Process{}, errors.New("the daemon is shutting down")
	}

	if spec.Command != "" {
		if err := os.MkdirAll(m.dir, 0o700); err != nil {
			return protocol.Process{}, err
		}
		if p.log, err = os.OpenFile(p.logPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600); err != nil {
			return protocol.Process{}, err
		}
		env := []string{"EVERYWHERE_THREAD=" + threadID, "EVERYWHERE_PROCESS=" + p.id, "EVERYWHERE_PROCESS_NAME=" + name}
		keys := make([]string, 0, len(spec.Env))
		for k := range spec.Env {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			env = append(env, k+"="+spec.Env[k])
		}
		p.tty, p.group, err = term.Spawn(term.Command{Dir: dir, Command: spec.Command, Env: env, Cols: ptyCols, Rows: ptyRows})
		if err != nil {
			_ = p.log.Close()
			end := now.UnixMilli()
			p.status, p.endedAt = protocol.ProcessFailed, &end
			p.save()
			m.changedThread(threadID)
			return p.view(), fmt.Errorf("starting %q: %w", name, err)
		}
	}
	p.save()
	m.mu.Lock()
	m.live[p.id] = p
	m.mu.Unlock()
	if p.tty != nil {
		go p.pump()
	}
	m.prune(threadID)
	if m.OnRunning != nil {
		m.OnRunning()
	}
	m.changedThread(threadID)
	return p.view(), nil
}

// Restart starts a process again the way it was last started.
func (m *Manager) Restart(id string) (protocol.Process, error) {
	row, err := m.store.GetProcess(id)
	if err != nil {
		return protocol.Process{}, err
	}
	var spec Spec
	if err := json.Unmarshal(row.Spec, &spec); err != nil {
		return protocol.Process{}, fmt.Errorf("%q can't be restarted: %w", row.Name, err)
	}
	return m.Start(row.ThreadID, row.AgentThreadID, row.Name, spec, true)
}

// Stop stops a process (or closes a tracker) and waits for it to end.
// by is who asked: the model, or the user.
func (m *Manager) Stop(id string, byUserReq bool) error {
	p := m.get(id)
	if p == nil {
		return errors.New("that process isn't running")
	}
	by := byModel
	if byUserReq {
		by = byUser
	}
	p.stop(by)
	return nil
}

// Remove stops a process if it's running and forgets it.
func (m *Manager) Remove(id string) error {
	if p := m.get(id); p != nil {
		p.stop(byDaemon)
	}
	row, err := m.store.GetProcess(id)
	if err != nil {
		return err
	}
	m.removeLog(id)
	if err := m.store.DeleteProcess(id); err != nil {
		return err
	}
	m.changedThread(row.ThreadID)
	return nil
}

// StopThread stops a thread's processes (it was archived).
func (m *Manager) StopThread(threadID string) {
	for _, p := range m.ofThread(threadID) {
		p.stop(byDaemon)
	}
}

// RemoveThread stops a thread's processes and deletes their logs; deleting
// the thread deletes their rows.
func (m *Manager) RemoveThread(threadID string) {
	m.StopThread(threadID)
	rows, _ := m.store.ListProcesses(threadID)
	for _, r := range rows {
		m.removeLog(r.ID)
	}
}

// Shutdown stops every process, briefly waiting for them to exit.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	m.closed = true
	all := make([]*proc, 0, len(m.live))
	for _, p := range m.live {
		all = append(all, p)
	}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, p := range all {
		wg.Go(func() { p.stopWithin(byDaemon, time.Second, time.Second) })
	}
	wg.Wait()
}

// List returns a thread's processes, most recently started first.
func (m *Manager) List(threadID string) ([]protocol.Process, error) {
	rows, err := m.store.ListProcesses(threadID)
	if err != nil {
		return nil, err
	}
	out := make([]protocol.Process, 0, len(rows))
	for _, r := range rows {
		if p := m.get(r.ID); p != nil {
			out = append(out, p.view())
		} else {
			out = append(out, m.rowView(r))
		}
	}
	return out, nil
}

// Find returns a thread's process by name.
func (m *Manager) Find(threadID, name string) (protocol.Process, error) {
	if p := m.byName(threadID, name); p != nil {
		return p.view(), nil
	}
	rows, err := m.store.ListProcesses(threadID)
	if err != nil {
		return protocol.Process{}, err
	}
	for _, r := range rows {
		if r.Name == name {
			return m.rowView(r), nil
		}
	}
	return protocol.Process{}, fmt.Errorf("no process named %q", name)
}

// Get returns a process by id.
func (m *Manager) Get(id string) (protocol.Process, error) {
	if p := m.get(id); p != nil {
		return p.view(), nil
	}
	row, err := m.store.GetProcess(id)
	if err != nil {
		return protocol.Process{}, err
	}
	return m.rowView(row), nil
}

// Running counts a thread's running processes (not trackers).
func (m *Manager) Running(threadID string) int {
	n := 0
	for _, p := range m.ofThread(threadID) {
		if p.tty != nil {
			n++
		}
	}
	return n
}

// Report applies a progress report from the model to a running process or
// tracker; done finishes a tracker.
func (m *Manager) Report(threadID, name string, r report, done bool) (protocol.Process, error) {
	p := m.byName(threadID, name)
	if p == nil {
		return protocol.Process{}, fmt.Errorf("no running process or tracker named %q (start a tracker with process_start and no command)", name)
	}
	if done && p.tty != nil {
		return protocol.Process{}, errors.New("done is for trackers; a process is done when it exits")
	}
	if r.Stat != "" && !validKey(r.Stat) {
		return protocol.Process{}, fmt.Errorf("stat key %q: use letters, digits, - and _", r.Stat)
	}
	p.mu.Lock()
	p.prog.apply(r, p.logSize+p.logBase, time.Now()) // the model reported it, so no need to tell it
	p.bump()
	p.mu.Unlock()
	if done {
		p.endTracker(protocol.ProcessDone)
	} else if p.tty == nil {
		p.save()
	}
	m.changedThread(threadID)
	return p.view(), nil
}

// Wait waits until a process reaches a checkpoint (or ends, if until is
// "exit"), the timeout passes or ctx ends. It reports whether until
// happened.
func (m *Manager) Wait(ctx context.Context, id, until string, timeout time.Duration) (protocol.Process, bool, error) {
	p := m.get(id)
	if p == nil {
		v, err := m.Get(id)
		return v, until == "exit" && err == nil, err
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	p.mu.Lock()
	if p.waiting == nil {
		p.waiting = map[string]int{}
	}
	p.waiting[until]++
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.waiting[until]--
		p.mu.Unlock()
	}()
	for {
		p.mu.Lock()
		reached := p.reachedLocked(until)
		ended := p.status != protocol.ProcessRunning
		ch := p.changed
		p.mu.Unlock()
		if reached || ended {
			return p.view(), reached, nil
		}
		select {
		case <-ch:
		case <-p.done:
		case <-timer.C:
			return p.view(), false, nil
		case <-ctx.Done():
			return p.view(), false, ctx.Err()
		}
	}
}

func (p *proc) reachedLocked(until string) bool {
	if until == "exit" {
		return p.status != protocol.ProcessRunning
	}
	for _, c := range p.prog.checkpoints {
		if c.Label == until {
			return c.ReachedAt != nil
		}
	}
	return false
}

// Output returns a process's output as plain text: the lines since a
// checkpoint (or all), those matching grep, the last tail of them, and at
// most maxBytes (keeping the end). It says whether it left lines out.
func (m *Manager) Output(id, sinceCheckpoint, grep string, tail, maxBytes int) ([]string, bool, error) {
	var re *regexp.Regexp
	if grep != "" {
		var err error
		if re, err = regexp.Compile(grep); err != nil {
			return nil, false, fmt.Errorf("grep: %w", err)
		}
	}
	v, err := m.Get(id)
	if err != nil {
		return nil, false, err
	}
	var from int64
	if sinceCheckpoint != "" {
		found := false
		for _, c := range v.Checkpoints {
			if c.Label == sinceCheckpoint {
				if c.ReachedAt == nil {
					return nil, false, fmt.Errorf("checkpoint %q hasn't been reached", sinceCheckpoint)
				}
				from, found = c.Offset, true
			}
		}
		if !found {
			return nil, false, fmt.Errorf("no checkpoint %q", sinceCheckpoint)
		}
	}
	base := m.logBase(id)
	raw, err := readFrom(filepath.Join(m.dir, id+".log"), max(0, from-base))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []string{}, false, nil
		}
		return nil, false, err
	}
	lines := plainLines(raw)
	if re != nil {
		kept := lines[:0]
		for _, l := range lines {
			if re.MatchString(l) {
				kept = append(kept, l)
			}
		}
		lines = kept
	}
	cut := false
	if tail > 0 && len(lines) > tail {
		lines, cut = lines[len(lines)-tail:], true
	}
	size := 0
	for i := len(lines) - 1; i >= 0; i-- {
		size += len(lines[i]) + 1
		if size > maxBytes {
			lines, cut = lines[i+1:], true
			break
		}
	}
	return lines, cut, nil
}

func (m *Manager) logBase(id string) int64 {
	if p := m.get(id); p != nil {
		p.mu.Lock()
		defer p.mu.Unlock()
		return p.logBase
	}
	row, err := m.store.GetProcess(id)
	if err != nil {
		return 0
	}
	var s saved
	_ = json.Unmarshal(row.Snapshot, &s)
	return s.LogBase
}

func readFrom(path string, off int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return nil, err
	}
	return io.ReadAll(f)
}

// readTail reads up to n bytes from the end of a file.
func readTail(path string, n int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	off := max(0, fi.Size()-n)
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return nil, err
	}
	return io.ReadAll(f)
}

// LogPath is where a process's raw output is.
func (m *Manager) LogPath(id string) string { return filepath.Join(m.dir, id+".log") }

// --- viewers: the terminal channel's protocol ----------------------------------

// Attach connects c to a process's output: its scrollback, then live output.
// A process that has ended replays the end of its log, then Exited.
// cols and rows are ignored: a viewer resizes once it's the writer.
func (m *Manager) Attach(id string, c term.Client, _, _ uint16) error {
	p := m.get(id)
	if p == nil {
		row, err := m.store.GetProcess(id)
		if err != nil {
			return err
		}
		raw, err := readTail(m.LogPath(id), scrollbackBytes)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		var h hideReports
		if shown := h.filter(raw); len(shown) > 0 {
			c.Output(shown)
		}
		code := -1
		if row.ExitCode != nil {
			code = *row.ExitCode
		}
		c.Exited(code)
		return nil
	}
	if p.tty == nil {
		return errors.New("a tracker has no output")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.scrollback) > 0 {
		c.Output(append([]byte(nil), p.scrollback...))
	}
	p.clients = append(p.clients, c)
	if p.writer == nil {
		p.writer = c
	}
	c.Writer(p.writer == c)
	return nil
}

// Detach removes c; the most recently attached client left takes over
// writing if c was the writer.
func (m *Manager) Detach(id string, c term.Client) {
	p := m.get(id)
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for i, x := range p.clients {
		if x == c {
			p.clients = append(p.clients[:i], p.clients[i+1:]...)
			break
		}
	}
	if p.writer == c {
		p.writer = nil
		if n := len(p.clients); n > 0 {
			p.writer = p.clients[n-1]
			p.writer.Writer(true)
		}
	}
}

// Input types into the process if c is the writer.
func (m *Manager) Input(id string, c term.Client, b []byte) {
	p := m.get(id)
	if p == nil || p.tty == nil {
		return
	}
	p.mu.Lock()
	ok := p.writer == c
	p.mu.Unlock()
	if ok {
		_, _ = p.tty.Write(b)
	}
}

// Resize resizes the process's terminal if c is the writer.
func (m *Manager) Resize(id string, c term.Client, cols, rows uint16) {
	p := m.get(id)
	if p == nil || p.tty == nil || cols == 0 || rows == 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.writer == c {
		_ = p.tty.Resize(cols, rows)
	}
}

// Takeover makes c the writer and sizes the terminal to it.
func (m *Manager) Takeover(id string, c term.Client, cols, rows uint16) {
	p := m.get(id)
	if p == nil || p.tty == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.writer == c {
		return
	}
	prev := p.writer
	p.writer = c
	if cols > 0 && rows > 0 {
		_ = p.tty.Resize(cols, rows)
	}
	if prev != nil {
		prev.Writer(false)
	}
	c.Writer(true)
}

// --- internals -------------------------------------------------------------

func (m *Manager) get(id string) *proc {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.live[id]
}

// byName finds a running process or open tracker; a tracker left open by a
// previous daemon is loaded from its row.
func (m *Manager) byName(threadID, name string) *proc {
	m.mu.Lock()
	for _, p := range m.live {
		if p.threadID == threadID && p.name == name {
			m.mu.Unlock()
			return p
		}
	}
	m.mu.Unlock()
	rows, err := m.store.ListProcesses(threadID)
	if err != nil {
		return nil
	}
	for _, r := range rows {
		if r.Name == name && r.Command == "" && r.Status == protocol.ProcessRunning {
			return m.loadTracker(r)
		}
	}
	return nil
}

func (m *Manager) loadTracker(r store.Process) *proc {
	var spec Spec
	_ = json.Unmarshal(r.Spec, &spec)
	var s saved
	_ = json.Unmarshal(r.Snapshot, &s)
	started := time.UnixMilli(r.StartedAt)
	prog, _ := newProgress(started, nil, nil, nil)
	prog.checkpoints = s.Checkpoints
	prog.patterns = make([]*regexp.Regexp, len(s.Checkpoints))
	for _, st := range s.Stats {
		x := &stat{ProcessStat: st}
		x.Rate, x.ETA, x.History = nil, nil, nil
		x.condition, _ = parseCondition(st.NotifyWhen)
		prog.stats = append(prog.stats, x)
	}
	prog.statusText = s.StatusText
	p := &proc{
		m: m, id: r.ID, threadID: r.ThreadID, agentThreadID: r.AgentThreadID, name: r.Name,
		spec: spec, cwd: r.Cwd, started: started, prev: r.Prev, done: make(chan struct{}),
		status: protocol.ProcessRunning, prog: prog, changed: make(chan struct{}),
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if have := m.live[r.ID]; have != nil {
		return have
	}
	m.live[r.ID] = p
	return p
}

func (m *Manager) ofThread(threadID string) []*proc {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*proc
	for _, p := range m.live {
		if p.threadID == threadID {
			out = append(out, p)
		}
	}
	return out
}

func (m *Manager) rowView(r store.Process) protocol.Process {
	var s saved
	_ = json.Unmarshal(r.Snapshot, &s)
	v := s.Process
	v.ID, v.ThreadID, v.Name, v.Command, v.Cwd = r.ID, r.ThreadID, r.Name, r.Command, r.Cwd
	v.Status, v.ExitCode, v.StartedAt, v.EndedAt = r.Status, r.ExitCode, r.StartedAt, r.EndedAt
	if v.Checkpoints == nil {
		v.Checkpoints = []protocol.ProcessCheckpoint{}
	}
	if v.Stats == nil {
		v.Stats = []protocol.ProcessStat{}
	}
	if r.Command != "" {
		v.LogPath = m.LogPath(r.ID)
	}
	return v
}

// changedThread schedules processes.changed for a thread.
func (m *Manager) changedThread(threadID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.timers[threadID] != nil {
		return
	}
	m.timers[threadID] = time.AfterFunc(changeEvery, func() {
		m.mu.Lock()
		delete(m.timers, threadID)
		m.mu.Unlock()
		if m.OnChange != nil {
			m.OnChange(threadID)
		}
	})
}

// prune deletes a thread's oldest finished processes beyond keepFinished.
func (m *Manager) prune(threadID string) {
	rows, err := m.store.ListProcesses(threadID)
	if err != nil {
		return
	}
	finished := 0
	for _, r := range rows {
		if r.Status == protocol.ProcessRunning {
			continue
		}
		if finished++; finished > keepFinished {
			m.removeLog(r.ID)
			_ = m.store.DeleteProcess(r.ID)
		}
	}
}

func (m *Manager) removeLog(id string) { _ = os.Remove(m.LogPath(id)) }

func (m *Manager) notify(p *proc, attrs, text string, wake bool) {
	if m.Notify == nil {
		return
	}
	text = strings.TrimSpace(text)
	m.Notify(p.threadID, p.agentThreadID, Notice{
		Name: p.name,
		Text: text,
		Prompt: fmt.Sprintf("<process-event name=%q %s>\nFrom a process this thread runs, not from the user.\n%s\n</process-event>",
			p.name, attrs, text),
		Wake: wake,
	})
}

func (p *proc) pump() {
	buf := make([]byte, 32*1024)
	for {
		n, err := p.tty.Read(buf)
		if n > 0 {
			p.output(buf[:n])
		}
		if err != nil {
			break
		}
	}
	code := p.tty.Wait()
	p.group.Release()
	_ = p.tty.Close()
	p.finish(code)
}

func (p *proc) output(chunk []byte) {
	p.mu.Lock()
	p.writeLog(chunk)
	if shown := p.hide.filter(chunk); len(shown) > 0 {
		p.scrollback = append(p.scrollback, shown...)
		if over := len(p.scrollback) - scrollbackBytes; over > 0 {
			p.scrollback = append([]byte(nil), p.scrollback[over:]...)
		}
		for _, c := range p.clients {
			c.Output(shown)
		}
	}
	p.text.write(chunk)
	evs := p.events
	p.events = nil
	p.bump()
	p.mu.Unlock()
	p.m.changedThread(p.threadID)
	for _, e := range evs {
		p.m.notify(p, e.attrs, e.text, true)
	}
}

// onLine is the text scanner's callback, under p.mu. The scanner has seen
// exactly what the log has, so its count is where the line ends in the log.
func (p *proc) onLine(s string) {
	for _, e := range p.prog.line(s, p.text.n, time.Now()) {
		// A tool call waiting for this checkpoint reports it.
		if e.checkpoint == "" || p.waiting[e.checkpoint] == 0 {
			p.events = append(p.events, e)
		}
	}
}

// awaited reports whether a Wait in progress will see the process end;
// under p.mu.
func (p *proc) awaited() bool {
	for _, n := range p.waiting {
		if n > 0 {
			return true
		}
	}
	return false
}

func (p *proc) writeLog(b []byte) {
	if p.log == nil {
		return
	}
	if p.logSize+int64(len(b)) > logMax {
		p.trimLog()
	}
	n, err := p.log.Write(b)
	p.logSize += int64(n)
	if err != nil {
		slog.Warn("writing process log", "process", p.id, "err", err)
		_ = p.log.Close()
		p.log = nil
	}
}

// trimLog keeps the last logKeep bytes of the log.
func (p *proc) trimLog() {
	keep, err := readTail(p.logPath, logKeep)
	if err == nil {
		tmp := p.logPath + ".tmp"
		if err = os.WriteFile(tmp, keep, 0o600); err == nil {
			err = os.Rename(tmp, p.logPath)
		}
	}
	_ = p.log.Close()
	if err != nil {
		slog.Warn("trimming process log", "process", p.id, "err", err)
		p.log = nil
		return
	}
	p.logBase += p.logSize - int64(len(keep))
	p.logSize = int64(len(keep))
	p.log, err = os.OpenFile(p.logPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		p.log = nil
	}
}

func (p *proc) finish(code int) {
	p.mu.Lock()
	if p.text.partial() != "" {
		p.text.write([]byte("\n"))
	}
	evs := p.events
	p.events = nil
	if p.stopping == "" {
		p.status = protocol.ProcessExited
	} else {
		p.status = protocol.ProcessStopped
	}
	p.exitCode = &code
	end := time.Now().UnixMilli()
	p.endedAt = &end
	if p.log != nil {
		_ = p.log.Close()
		p.log = nil
	}
	clients := p.clients
	p.clients, p.writer = nil, nil
	stopping := p.stopping
	awaited := p.awaited()
	tail := plainLines(p.scrollback[max(0, len(p.scrollback)-32<<10):])
	p.bump()
	close(p.done)
	p.mu.Unlock()

	p.save()
	p.m.mu.Lock()
	if p.m.live[p.id] == p {
		delete(p.m.live, p.id)
	}
	p.m.mu.Unlock()
	for _, c := range clients {
		c.Exited(code)
	}
	if p.m.OnRunning != nil {
		p.m.OnRunning()
	}
	p.m.changedThread(p.threadID)
	for _, e := range evs {
		p.m.notify(p, e.attrs, e.text, true)
	}

	if len(tail) > 15 {
		tail = tail[len(tail)-15:]
	}
	took := shortDuration(time.Since(p.started))
	switch {
	case awaited:
		// The tool call waiting on it reports how it ended.
	case stopping == "":
		p.m.notify(p, fmt.Sprintf(`status="exited" code="%d"`, code),
			fmt.Sprintf("Exited with code %d after %s. Last lines:\n%s", code, took, strings.Join(tail, "\n")), p.spec.Notify)
	case stopping == byUser:
		p.m.notify(p, `status="stopped"`, fmt.Sprintf("The user stopped it after %s.", took), false)
	}
}

// endTracker closes a tracker.
func (p *proc) endTracker(status string) {
	p.mu.Lock()
	if p.status != protocol.ProcessRunning {
		p.mu.Unlock()
		return
	}
	p.status = status
	end := time.Now().UnixMilli()
	p.endedAt = &end
	p.bump()
	close(p.done)
	p.mu.Unlock()
	p.save()
	p.m.mu.Lock()
	if p.m.live[p.id] == p {
		delete(p.m.live, p.id)
	}
	p.m.mu.Unlock()
	p.m.changedThread(p.threadID)
}

func (p *proc) stop(by string) { p.stopWithin(by, 3*time.Second, 3*time.Second) }

// stopWithin interrupts the process, then terminates it after grace, then
// kills it after another kill.
func (p *proc) stopWithin(by string, grace, kill time.Duration) {
	if p.tty == nil {
		if by == byDaemon {
			p.save() // a tracker outlives the daemon
			return
		}
		p.endTracker(protocol.ProcessStopped)
		return
	}
	p.mu.Lock()
	if p.stopping == "" {
		p.stopping = by
	}
	p.mu.Unlock()
	for _, step := range []struct {
		sig  syscall.Signal
		wait time.Duration
	}{{syscall.SIGINT, grace}, {syscall.SIGTERM, kill}, {syscall.SIGKILL, 2 * time.Second}} {
		_ = p.group.Signal(step.sig)
		select {
		case <-p.done:
			return
		case <-time.After(step.wait):
		}
	}
}

// bump wakes waiters; under p.mu.
func (p *proc) bump() {
	close(p.changed)
	p.changed = make(chan struct{})
}

func (p *proc) view() protocol.Process {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.viewLocked()
}

func (p *proc) viewLocked() protocol.Process {
	v := protocol.Process{
		ID: p.id, ThreadID: p.threadID, Name: p.name, Command: p.spec.Command, Cwd: p.cwd,
		Status: p.status, ExitCode: p.exitCode, Notify: p.spec.Notify,
		StartedAt: p.started.UnixMilli(), EndedAt: p.endedAt,
	}
	p.prog.fill(&v, time.Now())
	if v.LastLine == "" && p.tty != nil {
		v.LastLine = p.text.partial()
	}
	if p.tty != nil {
		v.LogPath = p.logPath
	}
	return v
}

// save writes the process's row.
func (p *proc) save() {
	p.mu.Lock()
	v := p.viewLocked()
	snap, _ := json.Marshal(saved{Process: v, LogBase: p.logBase})
	spec, _ := json.Marshal(p.spec)
	prev := p.prev
	if p.status != protocol.ProcessRunning {
		// Keep the previous run's timings for checkpoints this one didn't reach.
		t := map[string]int64{}
		_ = json.Unmarshal(prev, &t)
		for k, ms := range p.prog.timings() {
			t[k] = ms
		}
		prev, _ = json.Marshal(t)
	}
	row := store.Process{
		ID: p.id, ThreadID: p.threadID, AgentThreadID: p.agentThreadID, Name: p.name,
		Command: p.spec.Command, Cwd: p.cwd, Spec: spec, Status: p.status, ExitCode: p.exitCode,
		StartedAt: v.StartedAt, EndedAt: p.endedAt, Snapshot: snap, Prev: prev,
	}
	p.mu.Unlock()
	if err := p.m.store.SaveProcess(row); err != nil {
		slog.Warn("saving process", "process", p.id, "err", err)
	}
}
