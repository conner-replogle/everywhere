// Package term runs thread shells as PTY child processes of the daemon and
// fans their output out to attached clients. Only one client (the writer) may
// type into or resize a thread at a time.
package term

import (
	"bufio"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

const (
	scrollbackBytes = 1 << 20
	// Typing marks a terminal as used at most this often.
	touchEvery    = 30 * time.Second
	restartNotice = "\x1b[2m[new shell — previous session ended]\x1b[0m\r\n"
)

// Resolver supplies per-thread shell details; implemented by store.Store.
type Resolver interface {
	ThreadShell(threadID string) (dir string, hadSession bool, err error)
	MarkSpawned(threadID string) error
	TouchThread(threadID string) error
}

// Client is one attached viewer (a browser's term channel).
type Client interface {
	// Output delivers PTY bytes. It must not block.
	Output(p []byte)
	Writer(you bool)
	Exited(code int)
}

type Manager struct {
	resolver Resolver
	onChange func() // called when a thread starts or stops running

	mu       sync.Mutex
	sessions map[string]*session
}

type session struct {
	threadID string
	cmd      *exec.Cmd
	ptmx     *os.File
	done     chan struct{}

	mu         sync.Mutex
	scrollback []byte
	clients    []Client // in attach order
	writer     Client
	touchedAt  time.Time // when typing last counted as using the thread
}

func NewManager(r Resolver, onChange func()) *Manager {
	return &Manager{resolver: r, onChange: onChange, sessions: map[string]*session{}}
}

// Running reports whether the thread currently has a live shell.
func (m *Manager) Running(threadID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.sessions[threadID]
	return ok
}

// Attach connects c to the thread, spawning its shell at cols x rows if it
// isn't running. c receives the scrollback, then live output. The first
// client to attach becomes the writer.
func (m *Manager) Attach(threadID string, c Client, cols, rows uint16) error {
	s, spawned, err := m.getOrSpawn(threadID, cols, rows)
	if err != nil {
		return err
	}
	if spawned && m.onChange != nil {
		m.onChange()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.scrollback) > 0 {
		c.Output(s.scrollback)
	}
	s.clients = append(s.clients, c)
	if s.writer == nil {
		s.writer = c
	}
	c.Writer(s.writer == c)
	return nil
}

// Detach removes c. If it was the writer, the most recently attached
// remaining client is promoted.
func (m *Manager) Detach(threadID string, c Client) {
	s := m.get(threadID)
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, x := range s.clients {
		if x == c {
			s.clients = append(s.clients[:i], s.clients[i+1:]...)
			break
		}
	}
	if s.writer == c {
		s.writer = nil
		if n := len(s.clients); n > 0 {
			s.writer = s.clients[n-1]
			s.writer.Writer(true)
		}
	}
}

// Input writes keystrokes from c, dropping them unless c is the writer.
func (m *Manager) Input(threadID string, c Client, p []byte) {
	s := m.get(threadID)
	if s == nil {
		return
	}
	s.mu.Lock()
	isWriter := s.writer == c
	touch := isWriter && time.Since(s.touchedAt) > touchEvery
	if touch {
		s.touchedAt = time.Now()
	}
	s.mu.Unlock()
	if isWriter {
		_, _ = s.ptmx.Write(p)
	}
	if touch {
		if err := m.resolver.TouchThread(threadID); err != nil {
			slog.Warn("touch thread", "thread", threadID, "err", err)
		}
		if m.onChange != nil {
			m.onChange()
		}
	}
}

// Resize resizes the PTY if c is the writer.
func (m *Manager) Resize(threadID string, c Client, cols, rows uint16) {
	s := m.get(threadID)
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.writer == c {
		s.resize(cols, rows)
	}
}

// Takeover makes c the writer and sizes the PTY to it.
func (m *Manager) Takeover(threadID string, c Client, cols, rows uint16) {
	s := m.get(threadID)
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.writer == c {
		return
	}
	prev := s.writer
	s.writer = c
	s.resize(cols, rows)
	if prev != nil {
		prev.Writer(false)
	}
	c.Writer(true)
}

// Scrollback returns a copy of the thread's recent output, or nil if its
// shell isn't running.
func (m *Manager) Scrollback(threadID string) []byte {
	s := m.get(threadID)
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.scrollback...)
}

// Type writes p to the thread's shell as keystrokes, whoever the writer is,
// spawning the shell at cols x rows if it isn't running. It's for callers
// with no terminal of their own (an agent over the hub's RPC).
func (m *Manager) Type(threadID string, p []byte, cols, rows uint16) error {
	s, spawned, err := m.getOrSpawn(threadID, cols, rows)
	if err != nil {
		return err
	}
	if spawned && m.onChange != nil {
		m.onChange()
	}
	_, err = s.ptmx.Write(p)
	return err
}

// Kill terminates a thread's shell (used when the thread is deleted).
func (m *Manager) Kill(threadID string) {
	if s := m.get(threadID); s != nil {
		s.kill()
	}
}

// Shutdown terminates every shell and waits briefly for them to exit.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	all := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.mu.Unlock()
	for _, s := range all {
		s.kill()
	}
}

func (m *Manager) get(threadID string) *session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[threadID]
}

func (m *Manager) getOrSpawn(threadID string, cols, rows uint16) (*session, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sessions[threadID]; ok {
		return s, false, nil
	}
	dir, hadSession, err := m.resolver.ThreadShell(threadID)
	if err != nil {
		return nil, false, err
	}
	if _, err := os.Stat(dir); err != nil {
		return nil, false, errors.New("project directory is missing: " + dir)
	}
	s, err := spawn(threadID, dir, cols, rows)
	if err != nil {
		return nil, false, err
	}
	if hadSession {
		s.scrollback = append(s.scrollback, restartNotice...)
	}
	if err := m.resolver.MarkSpawned(threadID); err != nil {
		slog.Warn("mark spawned", "thread", threadID, "err", err)
	}
	m.sessions[threadID] = s
	go m.pump(s)
	return s, true, nil
}

// pump copies PTY output to scrollback and clients until the shell exits.
func (m *Manager) pump(s *session) {
	buf := make([]byte, 32*1024)
	for {
		n, err := s.ptmx.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			s.mu.Lock()
			s.appendScrollback(chunk)
			for _, c := range s.clients {
				c.Output(chunk)
			}
			s.mu.Unlock()
		}
		if err != nil {
			break
		}
	}
	code := 0
	if err := s.cmd.Wait(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		} else {
			code = -1
		}
	}
	_ = s.ptmx.Close()
	close(s.done)

	m.mu.Lock()
	if m.sessions[s.threadID] == s {
		delete(m.sessions, s.threadID)
	}
	m.mu.Unlock()

	s.mu.Lock()
	clients := s.clients
	s.clients = nil
	s.writer = nil
	s.mu.Unlock()
	for _, c := range clients {
		c.Exited(code)
	}
	if m.onChange != nil {
		m.onChange()
	}
}

func (s *session) appendScrollback(p []byte) {
	s.scrollback = append(s.scrollback, p...)
	if over := len(s.scrollback) - scrollbackBytes; over > 0 {
		// Copy rather than reslice so the backing array doesn't grow forever.
		s.scrollback = append([]byte(nil), s.scrollback[over:]...)
	}
}

func (s *session) resize(cols, rows uint16) {
	if cols == 0 || rows == 0 {
		return
	}
	_ = pty.Setsize(s.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
}

func (s *session) kill() {
	pid := s.cmd.Process.Pid
	_ = syscall.Kill(-pid, syscall.SIGHUP)
	select {
	case <-s.done:
	case <-time.After(3 * time.Second):
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}
}

func spawn(threadID, dir string, cols, rows uint16) (*session, error) {
	shell := loginShell()
	cmd := exec.Command(shell)
	cmd.Args = []string{"-" + filepath.Base(shell)} // login shell
	cmd.Dir = dir
	cmd.Env = shellEnv(shell, threadID)
	if cols == 0 || rows == 0 {
		cols, rows = 80, 24
	}
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}
	return &session{threadID: threadID, cmd: cmd, ptmx: ptmx, done: make(chan struct{})}, nil
}

// loginShell returns the current user's shell from /etc/passwd, then $SHELL,
// then /bin/sh.
func loginShell() string {
	if u, err := user.Current(); err == nil {
		if f, err := os.Open("/etc/passwd"); err == nil {
			defer f.Close()
			sc := bufio.NewScanner(f)
			for sc.Scan() {
				fields := strings.Split(sc.Text(), ":")
				if len(fields) >= 7 && fields[0] == u.Username && fields[6] != "" {
					if _, err := os.Stat(fields[6]); err == nil {
						return fields[6]
					}
				}
			}
		}
	}
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	return "/bin/sh"
}

// Environment variables from the daemon's service manager that shouldn't leak
// into user shells.
var dropEnv = map[string]bool{
	"INVOCATION_ID": true, "JOURNAL_STREAM": true, "NOTIFY_SOCKET": true,
	"MANAGERPID": true, "SYSTEMD_EXEC_PID": true, "LISTEN_FDS": true, "LISTEN_PID": true,
}

func shellEnv(shell, threadID string) []string {
	env := []string{}
	have := map[string]bool{}
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if dropEnv[k] || k == "TERM" || k == "COLORTERM" || k == "SHELL" {
			continue
		}
		have[k] = true
		env = append(env, kv)
	}
	if u, err := user.Current(); err == nil {
		for k, v := range map[string]string{"HOME": u.HomeDir, "USER": u.Username, "LOGNAME": u.Username} {
			if !have[k] {
				env = append(env, k+"="+v)
			}
		}
	}
	if !have["PATH"] {
		env = append(env, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	}
	if !have["LANG"] {
		env = append(env, "LANG=C.UTF-8")
	}
	return append(env,
		"SHELL="+shell,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"EVERYWHERE_THREAD="+threadID,
	)
}
