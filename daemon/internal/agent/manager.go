// Package agent runs Claude conversations for claude threads. Each active
// thread gets one claude process, started (or resumed) when a prompt
// arrives and stopped after it has been idle for a while. Its output becomes
// a persisted event log plus live state that browsers attach to, much like
// term does for shells.
package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/claude"
	"github.com/conner-replogle/everywhere/daemon/internal/gitx"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

// Client is one attached viewer (a browser's agent channel). Send must not
// block.
type Client interface {
	Send(frame any)
}

// Store is the persistence the manager needs; implemented by *store.Store.
type Store interface {
	GetThread(id string) (protocol.Thread, error)
	RenameThread(id, name string) (protocol.Thread, error)
	ReplaceThreadName(id, from, to string) (bool, error)
	AgentThread(threadID string) (store.AgentThread, error)
	SetAgentSessionID(threadID, sessionID string) error
	SetAgentResumeAt(threadID, entry string) error
	SetAgentModel(threadID, model string) error
	SetAgentPermissionMode(threadID, mode string) error
	SetAgentWorkspace(threadID, workspace, baseBranch string) error
	SetAgentWorktree(threadID, path, branch string) error
	SetAgentContinue(threadID string, cont bool) error
	AgentThreadsToContinue() ([]string, error)
	SetAgentContext(threadID string, usage json.RawMessage) error
	SetAgentEffort(threadID, effort string) error
	SetAgentThinking(threadID string, on bool) error
	AppendAgentEvent(threadID string, event json.RawMessage) (store.AgentEvent, error)
	AgentEvents(threadID string, afterSeq, beforeSeq int64, limit int) ([]store.AgentEvent, bool, error)
	AgentPromptSeq(threadID, id string) (int64, error)
	DeleteAgentEvents(threadID string, fromSeq, toSeq int64) error
}

// process is a running claude CLI; *claude.Session implements it.
type process interface {
	Messages() <-chan claude.Message
	Init() claude.InitResponse
	Err() error
	Send(claude.UserMessage) error
	Respond(*claude.PermissionRequest, claude.PermissionResult) error
	Interrupt(context.Context) error
	SetPermissionMode(context.Context, string) error
	SetModel(context.Context, string) error
	ContextUsage(context.Context) (claude.ContextUsage, error)
	GenerateTitle(ctx context.Context, description string, persist bool) (string, error)
	ApplyFlagSettings(context.Context, map[string]any) error
	Usage(context.Context) (claude.Usage, error)
	RewindFiles(ctx context.Context, userMessageID string, dryRun bool) (claude.RewindFilesResult, error)
	Close()
}

type Manager struct {
	// IdleTimeout stops a claude process after this long without a turn.
	// The next prompt resumes the conversation.
	IdleTimeout time.Duration
	// WorktreeDir holds the worktrees of threads that run in one.
	WorktreeDir string
	// ThreadArgs, if set, gives a thread's claude process extra CLI flags,
	// like an MCP server of the daemon's own with a token for that thread.
	// release is called once that process has ended.
	ThreadArgs func(threadID, projectID string) (args []string, release func(), err error)
	// Notify, if set, is told when a thread needs the user or finishes a
	// turn (for push notifications). It's called on its own goroutine.
	Notify func(protocol.HubNotify)

	attachments attachmentStore

	store    Store
	onChange func() // called when a thread's running state or status changes
	start    func(context.Context, claude.Options) (process, error)
	// forkPoint finds the transcript entry before a prompt; see
	// claude.ForkPoint.
	forkPoint func(sessionID, promptID string) (string, error)

	launchMu sync.Mutex
	bin      string
	env      []string

	mu           sync.Mutex
	sessions     map[string]*session
	models       []protocol.AgentModel
	account      *protocol.AgentAccount
	commands     []protocol.AgentCommand
	terminalOnly []string // commands claude's own terminal UI keeps to itself
	limits       []protocol.AgentLimit
	infoAt       time.Time // when models/account were last refreshed

	probeMu sync.Mutex // one Info probe at a time
}

// How long Info reuses what the last claude start reported.
const infoTTL = 10 * time.Minute

// NewManager keeps worktrees and attachments under dataDir.
func NewManager(st Store, dataDir string, onChange func()) *Manager {
	m := &Manager{
		IdleTimeout: 30 * time.Minute,
		WorktreeDir: filepath.Join(dataDir, "worktrees"),
		attachments: attachmentStore{root: filepath.Join(dataDir, "attachments")},
		store:       st,
		onChange:    onChange,
		sessions:    map[string]*session{},
	}
	m.start = m.startClaude
	m.forkPoint = m.transcriptForkPoint
	return m
}

// Attach connects c to a thread: it replays up to limit of the newest events
// after afterSeq (0 means the most it will send), then sends the live state
// and every change after it.
func (m *Manager) Attach(threadID string, c Client, afterSeq int64, limit int) error {
	s, err := m.session(threadID)
	if err != nil {
		return err
	}
	s.do(func() { s.attach(c, afterSeq, limit) })
	return nil
}

func (m *Manager) Detach(threadID string, c Client) {
	m.mu.Lock()
	s := m.sessions[threadID]
	m.mu.Unlock()
	if s != nil {
		s.do(func() { delete(s.clients, c) })
	}
}

// Handle runs a client request other than attach.
func (m *Manager) Handle(threadID string, c Client, msg protocol.AgentClientMsg) {
	s, err := m.session(threadID)
	if err != nil {
		c.Send(errorMsg(err.Error()))
		return
	}
	s.do(func() { s.handle(c, msg) })
}

// Request runs a request other than attach for a caller with no channel
// of its own (an agent over the hub's RPC) and returns its error.
func (m *Manager) Request(threadID string, msg protocol.AgentClientMsg) error {
	if msg.T == "attach" || msg.T == "history" {
		return fmt.Errorf("%s needs a channel", msg.T)
	}
	s, err := m.session(threadID)
	if err != nil {
		return err
	}
	c := &errClient{}
	ran := false
	s.call(func() {
		ran = true
		s.handle(c, msg)
	})
	if !ran {
		return errClosed
	}
	return c.err
}

// State is a thread's live state, as an attached client sees it.
func (m *Manager) State(threadID string) (protocol.AgentState, error) {
	s, err := m.session(threadID)
	if err != nil {
		return protocol.AgentState{}, err
	}
	var st protocol.AgentState
	ran := false
	s.call(func() {
		ran = true
		st = s.stateMsg().State
	})
	if !ran {
		return st, errClosed
	}
	return st, nil
}

var errClosed = errors.New("this thread was closed")

// errClient keeps the first error a request reports.
type errClient struct{ err error }

func (c *errClient) Send(frame any) {
	if e, ok := frame.(protocol.AgentErrorMsg); ok && c.err == nil {
		c.err = errors.New(e.Message)
	}
}

// Status reports whether a thread has a claude process and its status.
func (m *Manager) Status(threadID string) (running bool, status string) {
	m.mu.Lock()
	s := m.sessions[threadID]
	m.mu.Unlock()
	if s == nil {
		return false, statusStopped
	}
	p := s.pub.Load()
	return p.running, p.status
}

// Kill stops a thread's claude process and forgets it (the thread was
// deleted or archived). A later attach or prompt starts a new session from
// the stored thread, resuming claude's conversation.
func (m *Manager) Kill(threadID string) {
	m.mu.Lock()
	s := m.sessions[threadID]
	delete(m.sessions, threadID)
	m.mu.Unlock()
	if s != nil {
		s.stop()
	}
}

// Remove cleans up after a deleted claude thread: its process, its
// attachments and, unless keepWorktree, its worktree (the branch stays). a
// is the thread as it was before deletion.
func (m *Manager) Remove(threadID string, a store.AgentThread, keepWorktree bool) {
	m.Kill(threadID)
	if err := m.attachments.remove(threadID); err != nil {
		slog.Warn("removing attachments", "thread", threadID, "err", err)
	}
	if a.Worktree == "" || keepWorktree || a.SharedWorktree {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := gitx.RemoveWorktree(ctx, a.Dir, a.Worktree); err != nil {
		slog.Warn("removing worktree", "thread", threadID, "path", a.Worktree, "err", err)
	}
}

// MarkForContinuation records which threads are mid-turn, so that
// ContinueMarked resumes them after the daemon restarts (for an update).
func (m *Manager) MarkForContinuation() {
	m.mu.Lock()
	sessions := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.mu.Unlock()
	for _, s := range sessions {
		s.call(func() {
			if s.proc == nil || !s.turnActive {
				return
			}
			if err := m.store.SetAgentContinue(s.threadID, true); err != nil {
				slog.Warn("marking thread to continue", "thread", s.threadID, "err", err)
				return
			}
			s.emit(protocol.AgentEvent{Type: "notice", Text: "The daemon is updating; this turn continues when it's back"})
		})
	}
}

// ContinueMarked continues the turns MarkForContinuation recorded. Each
// thread is tried once: the mark is cleared first, so a turn that keeps
// failing can't loop.
func (m *Manager) ContinueMarked() {
	ids, err := m.store.AgentThreadsToContinue()
	if err != nil {
		slog.Warn("listing threads to continue", "err", err)
		return
	}
	for _, id := range ids {
		if err := m.store.SetAgentContinue(id, false); err != nil {
			slog.Warn("clearing continue mark", "thread", id, "err", err)
			continue
		}
		s, err := m.session(id)
		if err != nil {
			continue
		}
		slog.Info("continuing claude thread after restart", "thread", id)
		s.do(s.continueTurn)
	}
}

// Shutdown stops every claude process.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	sessions := m.sessions
	m.sessions = map[string]*session{}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, s := range sessions {
		wg.Go(s.stop)
	}
	wg.Wait()
}

func (m *Manager) session(threadID string) (*session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s := m.sessions[threadID]; s != nil {
		return s, nil
	}
	a, err := m.store.AgentThread(threadID)
	if err != nil {
		return nil, err
	}
	s := newSession(m, threadID, a)
	m.sessions[threadID] = s
	go s.run()
	return s, nil
}

// Info reports whether claude is usable here and its models and account.
// Without a recent session to learn them from, it starts a throwaway claude
// just for the initialize handshake (no prompt, so no API use).
func (m *Manager) Info(ctx context.Context) protocol.AgentInfo {
	m.probeMu.Lock()
	defer m.probeMu.Unlock()
	if info, ok := m.cachedInfo(); ok {
		return info
	}
	home, _ := os.UserHomeDir()
	p, err := m.start(ctx, claude.Options{Dir: home})
	if err != nil {
		return protocol.AgentInfo{Error: err.Error(), Models: []protocol.AgentModel{}}
	}
	go func() {
		for range p.Messages() {
		}
	}()
	m.noteInit(p.Init())
	uctx, cancel := context.WithTimeout(ctx, controlTimeout)
	if u, err := p.Usage(uctx); err == nil {
		m.setLimits(limitsFromUsage(u))
	}
	cancel()
	p.Close()
	info, _ := m.cachedInfo()
	return info
}

func (m *Manager) cachedInfo() (protocol.AgentInfo, bool) {
	m.mu.Lock()
	fresh := !m.infoAt.IsZero() && time.Since(m.infoAt) <= infoTTL
	info := protocol.AgentInfo{Available: true, Models: m.models, Account: m.account, Limits: m.limits}
	m.mu.Unlock()
	if !fresh {
		return protocol.AgentInfo{}, false
	}
	info.Commands = m.visibleCommands()
	return info, true
}

func (m *Manager) initInfo() ([]protocol.AgentModel, *protocol.AgentAccount) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.models, m.account
}

// startClaude launches the real CLI. The binary and the login-shell
// environment are looked up on first use; a failed lookup is retried next
// time, so installing claude doesn't need a daemon restart.
func (m *Manager) startClaude(ctx context.Context, o claude.Options) (process, error) {
	m.launchMu.Lock()
	if m.bin == "" {
		bin, err := claude.FindBinary(ctx)
		if err != nil {
			m.launchMu.Unlock()
			return nil, err
		}
		m.bin, m.env = bin, loginEnv(ctx)
	}
	o.Binary, o.Env = m.bin, m.env
	m.launchMu.Unlock()
	return claude.Start(ctx, o)
}

// transcriptForkPoint reads the fork point from the claude config directory
// the thread's process was (or would be) started with.
func (m *Manager) transcriptForkPoint(sessionID, promptID string) (string, error) {
	m.launchMu.Lock()
	env := m.env
	m.launchMu.Unlock()
	return claude.ForkPoint(claude.ConfigDir(env), sessionID, promptID)
}

// loginEnv returns the environment of the user's login shell, which is what
// they'd have in a terminal: systemd starts the daemon with a minimal PATH,
// and claude's tools inherit whatever we give it.
func loginEnv(ctx context.Context) []string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	// The marker skips anything the profile prints before env runs.
	const marker = "\x00__everywhere_env__\x00"
	out, err := exec.CommandContext(ctx, shell, "-lc", `printf '\0__everywhere_env__\0'; env -0`).Output()
	if err != nil {
		return nil
	}
	_, after, ok := bytes.Cut(out, []byte(marker))
	if !ok {
		return nil
	}
	var env []string
	for _, kv := range bytes.Split(after, []byte{0}) {
		if bytes.IndexByte(kv, '=') > 0 {
			env = append(env, string(kv))
		}
	}
	return env
}

func errorMsg(message string) protocol.AgentErrorMsg {
	return protocol.AgentErrorMsg{T: "error", Message: message}
}
