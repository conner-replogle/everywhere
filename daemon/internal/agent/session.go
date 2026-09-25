package agent

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/claude"
	"github.com/conner-replogle/everywhere/daemon/internal/gitx"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

const (
	statusStopped  = "stopped"
	statusStarting = "starting"
	statusIdle     = "idle"
	statusWorking  = "working"
	statusWaiting  = "waiting"
	statusError    = "error"

	replayLimit    = 5000
	startTimeout   = time.Minute
	controlTimeout = 5 * time.Second
	maxOutputBytes = 32 << 10 // per tool result
	maxInputBytes  = 64 << 10 // per tool input
	maxInputString = 16 << 10 // per string inside an oversized tool input
	maxTitleRunes  = 60
	titleTimeout   = 30 * time.Second
	// A first prompt shorter than this rarely says what the thread is about
	// ("fix this"), so it's named again once claude has replied.
	vagueWords = 6
	// How much of the first prompt and reply a renaming sees.
	maxTitleContext = 4000

	workspaceLocal    = "local"
	workspaceWorktree = "worktree"

	// What a turn interrupted by a daemon update is continued with, as in
	// t3code.
	continuePrompt = "Continue where you left off."
)

var (
	permissionModes = []string{"default", "acceptEdits", "plan", "auto", "bypassPermissions"}
	effortLevels    = []string{"low", "medium", "high", "xhigh", "max"}
	// defaultThreadName matches names the store generates, which a first
	// prompt replaces.
	defaultThreadName = regexp.MustCompile(`^claude \d+$`)
)

type published struct {
	running bool
	status  string
}

// session is one claude thread. Everything below the channels is owned by
// the run goroutine; other goroutines reach it through do.
type session struct {
	m        *Manager
	threadID string
	cmds     chan func()
	quit     chan struct{}
	exited   chan struct{}
	pub      atomic.Pointer[published]

	proc        process
	procMsgs    <-chan claude.Message
	releaseArgs func() // from Manager.ThreadArgs, for the running process
	clients     map[Client]bool
	state       protocol.AgentState
	pending     map[string]*claude.PermissionRequest
	turnActive  bool
	interrupted bool // the user stopped the current turn
	stopping    bool // we're closing the process on purpose
	msgID       string
	idle        *time.Timer
	titled      bool
	// autoName is the name the daemon gave the thread, while it has it. A
	// generated title only replaces this, never a name the user chose.
	autoName string
	// refineTitle is the first prompt, while the thread should be named
	// again when its first turn ends.
	refineTitle string
	titleGen    int    // bumped per title request, so only the latest applies
	firstReply  string // claude's last top-level text in the current turn
}

func newSession(m *Manager, threadID string, a store.AgentThread) *session {
	var usage *protocol.AgentContext
	if a.Context != nil {
		usage = new(protocol.AgentContext)
		if json.Unmarshal(a.Context, usage) != nil {
			usage = nil
		}
	}
	s := &session{
		m:        m,
		threadID: threadID,
		cmds:     make(chan func(), 64),
		quit:     make(chan struct{}),
		exited:   make(chan struct{}),
		clients:  map[Client]bool{},
		pending:  map[string]*claude.PermissionRequest{},
		state: protocol.AgentState{
			Status:         statusStopped,
			SessionID:      a.SessionID,
			Model:          a.Model,
			PermissionMode: a.PermissionMode,
			Pending:        []protocol.AgentRequest{},
			Streaming:      []protocol.AgentStreaming{},
			Workspace: protocol.AgentWorkspace{
				Mode:       a.Workspace,
				BaseBranch: a.BaseBranch,
				Path:       a.Worktree,
				Branch:     a.Branch,
				Locked:     a.SessionID != "" || a.Worktree != "",
			},
			Context:  usage,
			Effort:   a.Effort,
			Thinking: a.Thinking,
		},
	}
	s.pub.Store(&published{status: statusStopped})
	return s
}

// do runs f on the session goroutine. It's dropped if the session has
// stopped.
func (s *session) do(f func()) {
	select {
	case s.cmds <- f:
	case <-s.exited:
	}
}

// call runs f on the session goroutine and waits for it.
func (s *session) call(f func()) {
	done := make(chan struct{})
	s.do(func() {
		defer close(done)
		f()
	})
	select {
	case <-done:
	case <-s.exited:
	}
}

func (s *session) stop() {
	close(s.quit)
	<-s.exited
}

func (s *session) run() {
	defer close(s.exited)
	for {
		var idle <-chan time.Time
		if s.idle != nil {
			idle = s.idle.C
		}
		select {
		case f := <-s.cmds:
			f()
		case msg, ok := <-s.procMsgs:
			if ok {
				s.handleMessage(msg)
			} else {
				s.onExit()
			}
		case <-idle:
			s.idle = nil
			if s.proc != nil && s.state.Status == statusIdle {
				slog.Info("stopping idle claude", "thread", s.threadID)
				s.closeProc()
			}
		case <-s.quit:
			if s.proc != nil {
				s.closeProc()
				for range s.procMsgs {
				}
				s.release()
			}
			for c := range s.clients {
				c.Send(errorMsg("this thread was closed"))
			}
			return
		}
	}
}

// --- client requests --------------------------------------------------------

func (s *session) attach(c Client, afterSeq int64, limit int) {
	events, truncated, err := s.m.store.AgentEvents(s.threadID, afterSeq, 0, pageLimit(limit))
	if err != nil {
		c.Send(errorMsg(err.Error()))
		return
	}
	for _, e := range events {
		c.Send(protocol.AgentEventMsg{T: "event", Seq: e.Seq, At: e.At, Event: e.Event})
	}
	c.Send(protocol.AgentSyncedMsg{T: "synced", Truncated: truncated})
	c.Send(s.stateMsg())
	s.clients[c] = true
}

// history sends the page of events before beforeSeq to c alone.
func (s *session) history(c Client, beforeSeq int64, limit int) {
	events, more, err := s.m.store.AgentEvents(s.threadID, 0, beforeSeq, pageLimit(limit))
	if err != nil {
		c.Send(errorMsg(err.Error()))
		return
	}
	msg := protocol.AgentHistoryMsg{T: "history", Events: make([]protocol.AgentLoggedEvent, len(events)), More: more}
	for i, e := range events {
		msg.Events[i] = protocol.AgentLoggedEvent{Seq: e.Seq, At: e.At, Event: e.Event}
	}
	c.Send(msg)
}

// pageLimit caps a client's requested page size; 0 asks for the most.
func pageLimit(limit int) int {
	if limit <= 0 || limit > replayLimit {
		return replayLimit
	}
	return limit
}

func (s *session) handle(c Client, msg protocol.AgentClientMsg) {
	var err error
	switch msg.T {
	case "history":
		// Only reads the log: nothing changed for other clients.
		s.history(c, msg.BeforeSeq, msg.Limit)
		return
	case "send":
		err = s.send(msg.Text, msg.Attachments)
	case "interrupt":
		s.interrupt()
	case "respond":
		err = s.respond(msg)
	case "setMode":
		err = s.setMode(msg.Mode)
	case "setModel":
		err = s.setModel(msg.Model)
	case "setWorkspace":
		err = s.setWorkspace(msg.Workspace, msg.BaseBranch)
	case "setEffort":
		err = s.setEffort(msg.Effort)
	case "rewind":
		err = s.rewind(msg.ID, msg.Files)
	case "setThinking":
		if msg.Thinking == nil {
			err = errors.New("setThinking needs thinking")
		} else {
			err = s.setThinking(*msg.Thinking)
		}
	default:
		err = fmt.Errorf("unknown request %q", msg.T)
	}
	if err != nil {
		c.Send(errorMsg(err.Error()))
	}
	s.changed()
}

func (s *session) send(text string, attachmentIDs []string) error {
	text = strings.TrimSpace(text)
	if text == "" && len(attachmentIDs) == 0 {
		return nil
	}
	files, err := s.m.attachments.resolve(s.threadID, attachmentIDs)
	if err != nil {
		return err
	}
	if err := s.ensureProc(); err != nil {
		return err
	}
	content, err := promptContent(text, files)
	if err != nil {
		return err
	}
	id := newUUID()
	if !s.turnActive {
		s.beginTurn()
	}
	ev := protocol.AgentEvent{Type: "user", ID: id, Text: text}
	for _, f := range files {
		ev.Attachments = append(ev.Attachments, f.AgentAttachment)
	}
	s.emit(ev)
	err = s.proc.Send(claude.UserMessage{UUID: id, Content: content})
	if err == nil {
		s.maybeTitle(text, files)
	}
	return err
}

// continueTurn restarts a turn that a daemon update interrupted.
func (s *session) continueTurn() {
	if err := s.ensureProc(); err != nil {
		s.emit(protocol.AgentEvent{Type: "notice", Text: "Couldn't continue after the daemon update: " + err.Error()})
		s.changed()
		return
	}
	if !s.turnActive {
		s.beginTurn()
	}
	s.emit(protocol.AgentEvent{Type: "notice", Text: "Continuing after the daemon update"})
	if err := s.proc.Send(claude.UserMessage{Content: []claude.ContentBlock{claude.Text(continuePrompt)}}); err != nil {
		slog.Warn("continuing claude turn", "thread", s.threadID, "err", err)
	}
	s.changed()
}

func (s *session) ensureProc() error {
	if s.proc != nil {
		return nil
	}
	a, err := s.m.store.AgentThread(s.threadID)
	if err != nil {
		return err
	}
	s.state.Status, s.state.Error = statusStarting, ""
	s.changed()

	ctx, cancel := context.WithTimeout(context.Background(), startTimeout)
	defer cancel()
	fail := func(err error) error {
		s.state.Status, s.state.Error = statusError, err.Error()
		return err
	}
	dir, err := s.workdir(ctx, a)
	if err != nil {
		return fail(err)
	}
	attachDir, err := s.m.attachments.dir(s.threadID)
	if err != nil {
		return fail(err)
	}
	var extra []string
	if s.m.ThreadArgs != nil {
		// Without them claude still works, just without the daemon's tools.
		if extra, s.releaseArgs, err = s.m.ThreadArgs(s.threadID, a.ProjectID); err != nil {
			slog.Warn("preparing claude's extra flags", "thread", s.threadID, "err", err)
			extra, s.releaseArgs = nil, nil
		}
	}
	p, err := s.m.start(ctx, claude.Options{
		Dir:            dir,
		Model:          a.Model,
		PermissionMode: a.PermissionMode,
		Resume:         a.SessionID,
		ResumeAt:       a.ResumeAt,
		// The fork's id arrives with the init message, which clears ResumeAt.
		ForkSession:       a.ResumeAt != "",
		FileCheckpointing: true,                // for rewinds that restore files
		AddDirs:           []string{attachDir}, // so claude can read attached files
		Settings:          sessionSettings(a.Effort, a.Thinking),
		// Predicted next prompts, shown as a hint in the composer.
		PromptSuggestions: true,
		Args:              extra,
	})
	if err != nil {
		s.release()
		return fail(err)
	}
	s.proc, s.procMsgs = p, p.Messages()
	s.m.noteInit(p.Init())
	s.state.Status = statusIdle
	s.state.Workspace.Locked = true
	s.refreshContext()
	s.refreshLimits()
	return nil
}

// sessionSettings is the flag-settings layer a thread starts with.
func sessionSettings(effort string, thinking bool) map[string]any {
	settings := map[string]any{}
	if effort != "" {
		settings["effortLevel"] = effort
	}
	if !thinking {
		settings["alwaysThinkingEnabled"] = false
	}
	return settings
}

// refreshLimits asks claude for the plan's usage windows, so they show
// before the first turn reports them.
func (s *session) refreshLimits() {
	ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
	defer cancel()
	if u, err := s.proc.Usage(ctx); err == nil {
		s.m.setLimits(limitsFromUsage(u))
	}
}

func (s *session) setEffort(effort string) error {
	if effort != "" && !slices.Contains(effortLevels, effort) {
		return fmt.Errorf("unknown effort %q", effort)
	}
	if s.proc != nil {
		ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
		defer cancel()
		var v any = effort
		if effort == "" {
			v = nil // back to the model's default
		}
		if err := s.proc.ApplyFlagSettings(ctx, map[string]any{"effortLevel": v}); err != nil {
			return err
		}
	}
	if err := s.m.store.SetAgentEffort(s.threadID, effort); err != nil {
		return err
	}
	s.state.Effort = effort
	return nil
}

func (s *session) setThinking(on bool) error {
	if s.proc != nil {
		ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
		defer cancel()
		if err := s.proc.ApplyFlagSettings(ctx, map[string]any{"alwaysThinkingEnabled": on}); err != nil {
			return err
		}
	}
	if err := s.m.store.SetAgentThinking(s.threadID, on); err != nil {
		return err
	}
	s.state.Thinking = on
	return nil
}

// workdir is where claude runs: the project directory, or the thread's
// worktree, which the first start creates.
func (s *session) workdir(ctx context.Context, a store.AgentThread) (string, error) {
	if a.Workspace != workspaceWorktree {
		return a.Dir, nil
	}
	// The project may be a subdirectory of its repository; run in the same
	// subdirectory of the worktree.
	prefix, err := gitx.Prefix(ctx, a.Dir)
	if err != nil {
		return "", fmt.Errorf("worktree mode needs a git repository: %w", err)
	}
	if a.Worktree != "" {
		if err := gitx.EnsureWorktree(ctx, a.Dir, a.Worktree, a.Branch); err != nil {
			return "", err
		}
		return filepath.Join(a.Worktree, prefix), nil
	}
	base := a.BaseBranch
	if base == "" {
		base = gitx.CurrentBranch(ctx, a.Dir)
	}
	if base == "" {
		base = "HEAD"
	}
	path := filepath.Join(s.m.WorktreeDir, filepath.Base(a.Dir)+"-"+a.ProjectID, s.threadID)
	branch := "everywhere/" + s.threadID
	if err := gitx.AddWorktree(ctx, a.Dir, path, branch, base); err != nil {
		return "", err
	}
	if err := s.m.store.SetAgentWorktree(s.threadID, path, branch); err != nil {
		return "", err
	}
	s.state.Workspace.Path, s.state.Workspace.Branch = path, branch
	s.emit(protocol.AgentEvent{Type: "notice", Text: fmt.Sprintf("Working in a new worktree on branch %s, from %s", branch, base)})
	return filepath.Join(path, prefix), nil
}

func (s *session) setWorkspace(mode, baseBranch string) error {
	if s.state.Workspace.Locked {
		return errors.New("the workspace can't change once the thread has started")
	}
	switch mode {
	case workspaceLocal:
		baseBranch = ""
	case workspaceWorktree:
		a, err := s.m.store.AgentThread(s.threadID)
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
		defer cancel()
		if !gitx.IsRepo(ctx, a.Dir) {
			return errors.New("worktrees need the project to be a git repository")
		}
	default:
		return fmt.Errorf("unknown workspace %q", mode)
	}
	if err := s.m.store.SetAgentWorkspace(s.threadID, mode, baseBranch); err != nil {
		return err
	}
	s.state.Workspace.Mode, s.state.Workspace.BaseBranch = mode, baseBranch
	return nil
}

// refreshContext asks claude how full the context window is.
func (s *session) refreshContext() {
	if s.proc == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
	defer cancel()
	u, err := s.proc.ContextUsage(ctx)
	if err != nil {
		slog.Debug("claude context usage", "thread", s.threadID, "err", err)
		return
	}
	s.setContext(u.TotalTokens, u.MaxTokens)
	if raw, err := json.Marshal(s.state.Context); err == nil {
		if err := s.m.store.SetAgentContext(s.threadID, raw); err != nil {
			slog.Warn("saving context usage", "thread", s.threadID, "err", err)
		}
	}
}

func (s *session) setContext(used, max int) {
	if max <= 0 {
		return
	}
	s.state.Context = &protocol.AgentContext{Used: used, Max: max, Percentage: float64(used) * 100 / float64(max)}
}

func (s *session) interrupt() {
	if s.proc == nil || !s.turnActive {
		return
	}
	s.interrupted = true
	ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
	defer cancel()
	if err := s.proc.Interrupt(ctx); err != nil {
		// A stuck CLI; the next prompt resumes the conversation.
		slog.Warn("claude interrupt failed, stopping it", "thread", s.threadID, "err", err)
		s.closeProc()
	}
}

// rewind rolls the conversation back to before the prompt with event id
// id, and with files, the files claude edited since. The conversation is cut
// by forking claude's session just before the prompt on its next start;
// the log loses the prompt and everything after it.
func (s *session) rewind(id string, files bool) error {
	if s.turnActive {
		return errors.New("stop claude before rolling back")
	}
	promptSeq, err := s.m.store.AgentPromptSeq(s.threadID, id)
	if err != nil {
		return fmt.Errorf("that message can't be rolled back to: %w", err)
	}
	var at string
	if s.state.SessionID != "" {
		if at, err = s.m.forkPoint(s.state.SessionID, id); err != nil {
			return fmt.Errorf("finding the message in claude's transcript: %w", err)
		}
	}
	restored := 0
	if files {
		if restored, err = s.rewindFiles(id); err != nil {
			return err
		}
	}
	// The running process holds the whole conversation; the next prompt
	// starts one on the fork.
	if s.proc != nil {
		s.stopProc()
	}
	if at == "" {
		// The prompt started the conversation: start a new one.
		err = s.m.store.SetAgentSessionID(s.threadID, "")
		s.state.SessionID = ""
	} else {
		err = s.m.store.SetAgentResumeAt(s.threadID, at)
	}
	if err != nil {
		return err
	}

	// The prompt's text, and the turn it started if it did.
	var text string
	fromSeq := promptSeq
	events, _, _ := s.m.store.AgentEvents(s.threadID, promptSeq-2, promptSeq+1, 2)
	for _, e := range events {
		var ev protocol.AgentEvent
		if json.Unmarshal(e.Event, &ev) != nil {
			continue
		}
		if e.Seq == promptSeq {
			text = ev.Text
		} else if ev.Type == "turn" && ev.Status == "started" {
			fromSeq = e.Seq
		}
	}
	// Logged before the cut, so seqs keep counting up from it.
	toSeq := s.emit(protocol.AgentEvent{Type: "rewind", ID: id, Text: text, FromSeq: fromSeq, FilesRestored: restored})
	if toSeq > 0 {
		if err := s.m.store.DeleteAgentEvents(s.threadID, fromSeq, toSeq); err != nil {
			slog.Warn("removing rolled back events", "thread", s.threadID, "err", err)
		}
	}
	s.state.Suggestion = ""
	return nil
}

// rewindFiles restores the files claude edited since prompt id and returns
// how many changed. It checks with a dry run first, so nothing is touched
// when claude can't restore them all.
func (s *session) rewindFiles(id string) (int, error) {
	if err := s.ensureProc(); err != nil {
		return 0, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
	defer cancel()
	r, err := s.proc.RewindFiles(ctx, id, true)
	if err == nil && !r.CanRewind {
		msg := r.Error
		if msg == "" {
			msg = "claude has no checkpoint for that message"
		}
		err = errors.New(msg)
	}
	if err != nil {
		return 0, fmt.Errorf("couldn't restore files: %w", err)
	}
	// Only a dry run reports what changes.
	n := len(r.FilesChanged)
	if n == 0 {
		return 0, nil
	}
	if r, err = s.proc.RewindFiles(ctx, id, false); err == nil && !r.CanRewind {
		err = errors.New(r.Error)
	}
	if err != nil {
		return 0, fmt.Errorf("couldn't restore files: %w", err)
	}
	return n, nil
}

// stopProc closes the process and handles what it still had to say.
func (s *session) stopProc() {
	s.closeProc()
	for msg := range s.procMsgs {
		s.handleMessage(msg)
	}
	s.onExit()
}

func (s *session) respond(msg protocol.AgentClientMsg) error {
	req := s.pending[msg.RequestID]
	if req == nil {
		return fmt.Errorf("that request is no longer waiting for an answer")
	}
	kind := requestKind(req.ToolName)
	var res claude.PermissionResult
	switch msg.Decision {
	case "allow", "allowSession":
		res = claude.Allow()
		if kind == "question" {
			res.UpdatedInput = withAnswers(req.Input, msg.Answers)
		}
		if msg.Decision == "allowSession" {
			res.UpdatedPermissions = req.Suggestions
		}
	case "deny":
		res = claude.Deny(msg.Message)
	default:
		return fmt.Errorf("unknown decision %q", msg.Decision)
	}
	if err := s.proc.Respond(req, res); err != nil {
		return err
	}
	s.resolve(req.ID, protocol.AgentEvent{Decision: msg.Decision, Answers: msg.Answers, Text: msg.Message})

	// Approving a plan leaves plan mode, into whatever mode the approval
	// picked.
	if res.Behavior == "allow" {
		if mode := setModeIn(res.UpdatedPermissions); mode != "" {
			s.notePermissionMode(mode)
		} else if kind == "plan" && s.state.PermissionMode == "plan" {
			s.notePermissionMode("default")
		}
	}
	return nil
}

// ValidPermissionMode reports whether claude knows mode.
func ValidPermissionMode(mode string) bool { return slices.Contains(permissionModes, mode) }

func (s *session) setMode(mode string) error {
	if !ValidPermissionMode(mode) {
		return fmt.Errorf("unknown permission mode %q", mode)
	}
	if s.proc != nil {
		ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
		defer cancel()
		if err := s.proc.SetPermissionMode(ctx, mode); err != nil {
			return err
		}
	}
	s.notePermissionMode(mode)
	return nil
}

func (s *session) setModel(model string) error {
	if s.proc != nil {
		ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
		defer cancel()
		m := model
		if m == "" {
			m = "default"
		}
		if err := s.proc.SetModel(ctx, m); err != nil {
			return err
		}
	}
	if err := s.m.store.SetAgentModel(s.threadID, model); err != nil {
		return err
	}
	s.state.Model = model
	return nil
}

func (s *session) notePermissionMode(mode string) {
	s.state.PermissionMode = mode
	if err := s.m.store.SetAgentPermissionMode(s.threadID, mode); err != nil {
		slog.Warn("saving permission mode", "thread", s.threadID, "err", err)
	}
}

// maybeTitle names a new thread after its first prompt, unless the user
// already renamed it: at once after the prompt's first line, then with
// the title claude generates for it.
func (s *session) maybeTitle(text string, files []storedAttachment) {
	if s.titled {
		return
	}
	s.titled = true
	t, err := s.m.store.GetThread(s.threadID)
	if err != nil || !defaultThreadName.MatchString(t.Name) {
		return
	}
	title, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
	if title == "" && len(files) > 0 {
		title = files[0].Name
	}
	if title == "" {
		return
	}
	if r := []rune(title); len(r) > maxTitleRunes {
		title = strings.TrimSpace(string(r[:maxTitleRunes-1])) + "…"
	}
	s.autoName = t.Name
	s.setAutoName(title)

	desc := text
	if len(files) > 0 {
		names := make([]string, len(files))
		for i, f := range files {
			names[i] = f.Name
		}
		desc = strings.TrimSpace(desc + "\n\nAttached: " + strings.Join(names, ", "))
	}
	if len(strings.Fields(text)) < vagueWords {
		s.refineTitle = desc
	}
	s.generateTitle(desc, true, func() { s.refineTitle = desc })
}

// generateTitle asks claude for a title off the session goroutine and
// applies it if nothing newer was asked for; failed runs if it gave none.
func (s *session) generateTitle(desc string, persist bool, failed func()) {
	proc := s.proc
	if proc == nil || s.autoName == "" {
		return
	}
	s.titleGen++
	gen := s.titleGen
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), titleTimeout)
		defer cancel()
		title, err := proc.GenerateTitle(ctx, clipRunes(desc, maxTitleContext), persist)
		if err != nil {
			slog.Debug("claude title", "thread", s.threadID, "err", err)
		}
		s.do(func() {
			if gen != s.titleGen {
				return
			}
			if title = strings.TrimSpace(title); title == "" {
				failed()
				return
			}
			s.setAutoName(title)
		})
	}()
}

// setAutoName renames the thread if it still has the daemon's name.
func (s *session) setAutoName(name string) {
	if s.autoName == "" || name == s.autoName {
		return
	}
	ok, err := s.m.store.ReplaceThreadName(s.threadID, s.autoName, name)
	if err != nil {
		slog.Warn("naming thread", "thread", s.threadID, "err", err)
		return
	}
	if !ok {
		s.autoName, s.refineTitle = "", "" // the user renamed it
		return
	}
	s.autoName = name
	s.m.onChange()
}

// maybeRefineTitle names the thread again from its first prompt and reply,
// once the first turn has ended, if the prompt alone wasn't enough.
func (s *session) maybeRefineTitle(completed bool) {
	prompt := s.refineTitle
	if prompt == "" || !completed || s.firstReply == "" {
		return
	}
	s.refineTitle = ""
	half := maxTitleContext / 2
	desc := clipRunes(prompt, half) + "\n\n" + clipRunes(s.firstReply, half)
	s.generateTitle(desc, false, func() {})
}

func clipRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// --- claude output ------------------------------------------------------------

func (s *session) handleMessage(msg claude.Message) {
	switch msg.Type {
	case "system":
		s.onSystem(msg)
	case "stream_event":
		// Streamed text goes out as deltas, not state pushes.
		if msg.ParentToolUseID == "" {
			s.onStreamEvent(msg)
		}
		return
	case "assistant":
		s.onAssistant(msg)
	case "user":
		s.onUser(msg)
	case "result":
		s.onResult(msg)
	case "control_request":
		s.onPermission(msg.Permission)
	case "control_cancel_request":
		s.resolve(msg.CanceledRequestID, protocol.AgentEvent{Decision: "canceled"})
	case "rate_limit_event":
		var f struct {
			Info json.RawMessage `json:"rate_limit_info"`
		}
		if msg.Decode(&f) == nil {
			s.state.RateLimit = f.Info
			s.m.setLimits(limitsFromEvent(f.Info))
		}
	case "prompt_suggestion":
		var f struct {
			Suggestion string `json:"suggestion"`
		}
		if msg.Decode(&f) == nil && !s.turnActive {
			s.state.Suggestion = strings.TrimSpace(f.Suggestion)
		}
	default:
		return
	}
	s.changed()
}

func (s *session) onSystem(msg claude.Message) {
	switch msg.Subtype {
	case "init":
		var f struct {
			Model            string   `json:"model"`
			PermissionMode   string   `json:"permissionMode"`
			TerminalCommands []string `json:"terminal_slash_commands"`
		}
		_ = msg.Decode(&f)
		s.m.noteTerminalCommands(f.TerminalCommands)
		s.state.ActiveModel = f.Model
		if f.PermissionMode != "" {
			s.state.PermissionMode = f.PermissionMode
		}
		if msg.SessionID != "" && msg.SessionID != s.state.SessionID {
			if err := s.m.store.SetAgentSessionID(s.threadID, msg.SessionID); err != nil {
				slog.Warn("saving claude session id", "thread", s.threadID, "err", err)
			}
			s.state.SessionID = msg.SessionID
		}
	case "compact_boundary":
		s.emit(protocol.AgentEvent{Type: "notice", Text: "Conversation compacted"})
		s.refreshContext()
	case "commands_changed":
		var f struct {
			Commands []claude.SlashCommand `json:"commands"`
		}
		if msg.Decode(&f) == nil {
			s.m.setCommands(f.Commands)
		}
	case "local_command_output":
		var f struct {
			Content string `json:"content"`
		}
		if msg.Decode(&f) == nil && strings.TrimSpace(f.Content) != "" {
			s.emit(protocol.AgentEvent{Type: "commandOutput", Text: clipText(f.Content, maxOutputBytes)})
		}
	}
}

func (s *session) onStreamEvent(msg claude.Message) {
	var f struct {
		Event struct {
			Type    string `json:"type"`
			Index   int    `json:"index"`
			Message struct {
				ID    string `json:"id"`
				Usage struct {
					InputTokens         int `json:"input_tokens"`
					CacheCreationTokens int `json:"cache_creation_input_tokens"`
					CacheReadTokens     int `json:"cache_read_input_tokens"`
				} `json:"usage"`
			} `json:"message"`
			ContentBlock struct {
				Type string `json:"type"`
			} `json:"content_block"`
			Delta struct {
				Type     string `json:"type"`
				Text     string `json:"text"`
				Thinking string `json:"thinking"`
			} `json:"delta"`
		} `json:"event"`
	}
	if msg.Decode(&f) != nil {
		return
	}
	if !s.turnActive {
		s.beginTurn()
		s.changed()
	}
	ev := f.Event
	key := fmt.Sprintf("%s:%d", s.msgID, ev.Index)
	switch ev.Type {
	case "message_start":
		s.msgID = ev.Message.ID
		// Everything sent to the model for this call is now in context; the
		// exact figure comes from claude when the turn ends.
		if c := s.state.Context; c != nil {
			u := ev.Message.Usage
			s.setContext(u.InputTokens+u.CacheCreationTokens+u.CacheReadTokens, c.Max)
			s.changed()
		}
	case "content_block_start":
		if kind := streamKind(ev.ContentBlock.Type); kind != "" {
			s.state.Streaming = append(s.state.Streaming, protocol.AgentStreaming{Key: key, Kind: kind})
		}
	case "content_block_delta":
		text := ev.Delta.Text
		if ev.Delta.Type == "thinking_delta" {
			text = ev.Delta.Thinking
		}
		if text == "" {
			return
		}
		for i := range s.state.Streaming {
			if st := &s.state.Streaming[i]; st.Key == key {
				st.Text += text
				s.broadcast(protocol.AgentDeltaMsg{T: "delta", Key: key, Kind: st.Kind, Text: text})
			}
		}
	}
}

func (s *session) onAssistant(msg claude.Message) {
	var f struct {
		Message struct {
			ID      string `json:"id"`
			Content []struct {
				Type     string          `json:"type"`
				Text     string          `json:"text"`
				Thinking string          `json:"thinking"`
				ID       string          `json:"id"`
				Name     string          `json:"name"`
				Input    json.RawMessage `json:"input"`
			} `json:"content"`
		} `json:"message"`
		Error string `json:"error"`
	}
	if msg.Decode(&f) != nil {
		return
	}
	if !s.turnActive {
		s.beginTurn()
	}
	for i, b := range f.Message.Content {
		id := msg.UUID
		if i > 0 {
			id = fmt.Sprintf("%s:%d", msg.UUID, i)
		}
		ev := protocol.AgentEvent{ID: id, ParentID: msg.ParentToolUseID}
		switch b.Type {
		case "text":
			ev.Type, ev.Text = "assistant", b.Text
			ev.StreamKey = s.takeStream(f.Message.ID, "text")
			if msg.ParentToolUseID == "" && strings.TrimSpace(b.Text) != "" {
				s.firstReply = b.Text
			}
		case "thinking":
			ev.Type, ev.Text = "thinking", b.Thinking
			ev.StreamKey = s.takeStream(f.Message.ID, "thinking")
			if b.Thinking == "" {
				continue // redacted or not summarized
			}
		case "tool_use", "server_tool_use", "mcp_tool_use":
			ev.Type, ev.ID, ev.Name, ev.Input = "tool", b.ID, b.Name, clipJSON(b.Input)
		default:
			continue
		}
		s.emit(ev)
	}
	if f.Error != "" {
		s.emit(protocol.AgentEvent{Type: "notice", Text: "Claude reported an error: " + f.Error})
	}
}

func (s *session) onUser(msg claude.Message) {
	var f struct {
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if msg.Decode(&f) != nil {
		return
	}
	var blocks []struct {
		Type      string          `json:"type"`
		ToolUseID string          `json:"tool_use_id"`
		Content   json.RawMessage `json:"content"`
		IsError   bool            `json:"is_error"`
	}
	if json.Unmarshal(f.Message.Content, &blocks) != nil {
		return // plain text: an echo of a prompt, already logged
	}
	for _, b := range blocks {
		if b.Type != "tool_result" {
			continue
		}
		s.emit(protocol.AgentEvent{
			Type:     "toolResult",
			ID:       b.ToolUseID,
			ParentID: msg.ParentToolUseID,
			Output:   clipText(contentText(b.Content), maxOutputBytes),
			IsError:  b.IsError,
		})
	}
}

func (s *session) onResult(msg claude.Message) {
	var r claude.Result
	var e struct {
		Errors []string `json:"errors"`
	}
	if msg.Decode(&r) != nil || msg.Decode(&e) != nil {
		return
	}
	ev := protocol.AgentEvent{Type: "turn", Status: "completed", CostUSD: r.TotalCostUSD, DurationMS: r.DurationMS}
	switch {
	case s.interrupted:
		ev.Status = "interrupted"
	case r.IsError || r.Subtype != "success":
		ev.Status = "error"
		ev.Text = r.Result
		if len(e.Errors) > 0 {
			ev.Text = strings.Join(e.Errors, "\n")
		}
	}
	s.endTurn(ev)
	s.maybeRefineTitle(ev.Status == "completed")
	s.refreshContext()
}

func (s *session) onPermission(req *claude.PermissionRequest) {
	if req == nil {
		return
	}
	if !s.turnActive {
		s.beginTurn()
	}
	s.pending[req.ID] = req
	s.state.Pending = append(s.state.Pending, protocol.AgentRequest{
		ID:              req.ID,
		Kind:            requestKind(req.ToolName),
		ToolName:        req.ToolName,
		ToolUseID:       req.ToolUseID,
		Input:           clipJSON(req.Input),
		Title:           req.Title,
		Description:     req.Description,
		DecisionReason:  req.DecisionReason,
		CanAllowSession: len(req.Suggestions) > 0,
	})
	kind := requestKind(req.ToolName)
	if kind == "tool" {
		s.notify("permission", req.ToolName)
	} else {
		s.notify(kind, "")
	}
}

// onExit handles the claude process ending, on purpose or not.
func (s *session) onExit() {
	err := s.proc.Err()
	s.proc, s.procMsgs = nil, nil
	s.release()
	expected := s.stopping || s.interrupted
	if s.turnActive {
		ev := protocol.AgentEvent{Type: "turn", Status: "interrupted"}
		if !expected {
			ev.Status, ev.Text = "error", "claude exited unexpectedly"
		}
		s.endTurn(ev)
	}
	s.state.ActiveModel = ""
	s.state.Status, s.state.Error = statusStopped, ""
	if err != nil && !expected {
		slog.Warn("claude exited", "thread", s.threadID, "err", err)
		s.state.Status, s.state.Error = statusError, err.Error()
	}
	s.stopping, s.interrupted = false, false
	s.changed()
}

// --- helpers --------------------------------------------------------------------

func (s *session) beginTurn() {
	s.turnActive, s.interrupted = true, false
	s.firstReply = ""
	s.state.Suggestion = ""
	s.emit(protocol.AgentEvent{Type: "turn", Status: "started"})
}

func (s *session) endTurn(ev protocol.AgentEvent) {
	for id := range s.pending {
		s.resolve(id, protocol.AgentEvent{Decision: "canceled"})
	}
	s.turnActive, s.interrupted = false, false
	s.state.Streaming = []protocol.AgentStreaming{}
	s.emit(ev)
	switch ev.Status {
	case "completed":
		s.notify("done", "")
	case "error":
		s.notify("error", "")
	}
}

// notify tells the manager's Notify that the thread needs the user (kind
// permission, question or plan) or finished its turn (done or error).
func (s *session) notify(kind, tool string) {
	if s.m.Notify == nil {
		return
	}
	t, err := s.m.store.GetThread(s.threadID)
	if err != nil {
		return
	}
	go s.m.Notify(protocol.HubNotify{
		T: "notify", ThreadID: t.ID, ParentID: t.ParentID, Name: t.Name, Kind: kind, Tool: tool,
	})
}

// resolve records the outcome of a pending request and forgets it. ev
// carries the decision details.
func (s *session) resolve(id string, ev protocol.AgentEvent) {
	req := s.pending[id]
	if req == nil {
		return
	}
	delete(s.pending, id)
	for i, p := range s.state.Pending {
		if p.ID == id {
			s.state.Pending = append(s.state.Pending[:i:i], s.state.Pending[i+1:]...)
			break
		}
	}
	ev.Type, ev.ID, ev.Kind = "request", id, requestKind(req.ToolName)
	ev.ToolName, ev.ToolUseID = req.ToolName, req.ToolUseID
	s.emit(ev)
}

// takeStream removes and returns the key of the oldest streaming block of
// the given kind in API message msgID.
func (s *session) takeStream(msgID, kind string) string {
	for i, st := range s.state.Streaming {
		if st.Kind == kind && strings.HasPrefix(st.Key, msgID+":") {
			s.state.Streaming = append(s.state.Streaming[:i:i], s.state.Streaming[i+1:]...)
			return st.Key
		}
	}
	return ""
}

// release gives back what ThreadArgs handed out for the ended process.
func (s *session) release() {
	if s.releaseArgs != nil {
		s.releaseArgs()
		s.releaseArgs = nil
	}
}

func (s *session) closeProc() {
	s.stopping = true
	s.proc.Close()
}

// emit logs ev and sends it to clients. It returns the event's seq, or 0 if
// it couldn't be saved.
func (s *session) emit(ev protocol.AgentEvent) int64 {
	raw, err := json.Marshal(ev)
	if err != nil {
		return 0
	}
	e, err := s.m.store.AppendAgentEvent(s.threadID, raw)
	if err != nil {
		slog.Warn("saving agent event", "thread", s.threadID, "err", err)
		return 0
	}
	s.broadcast(protocol.AgentEventMsg{T: "event", Seq: e.Seq, At: e.At, Event: e.Event})
	return e.Seq
}

func (s *session) broadcast(frame any) {
	for c := range s.clients {
		c.Send(frame)
	}
}

func (s *session) stateMsg() protocol.AgentStateMsg {
	st := s.state
	st.Models, st.Account = s.m.initInfo()
	if st.Models == nil {
		st.Models = []protocol.AgentModel{}
	}
	st.Commands = s.m.visibleCommands()
	st.Limits = s.m.currentLimits()
	return protocol.AgentStateMsg{T: "state", State: st}
}

// changed recomputes the status of a running session, pushes the state to
// clients and tells the manager if the thread's summary changed.
func (s *session) changed() {
	if s.proc != nil && s.state.Status != statusStarting {
		switch {
		case len(s.pending) > 0:
			s.state.Status = statusWaiting
		case s.turnActive:
			s.state.Status = statusWorking
		default:
			s.state.Status = statusIdle
		}
	}
	if s.state.Status == statusIdle {
		if s.idle == nil {
			s.idle = time.NewTimer(s.m.IdleTimeout)
		}
	} else if s.idle != nil {
		s.idle.Stop()
		s.idle = nil
	}
	s.broadcast(s.stateMsg())
	next := &published{running: s.proc != nil, status: s.state.Status}
	if prev := s.pub.Swap(next); *prev != *next {
		s.m.onChange()
	}
}

func requestKind(toolName string) string {
	switch toolName {
	case "AskUserQuestion":
		return "question"
	case "ExitPlanMode":
		return "plan"
	}
	return "tool"
}

func streamKind(blockType string) string {
	switch blockType {
	case "text":
		return "text"
	case "thinking":
		return "thinking"
	}
	return ""
}

// withAnswers adds AskUserQuestion answers to its input, which is how the
// tool receives them.
func withAnswers(input json.RawMessage, answers map[string]string) json.RawMessage {
	var m map[string]any
	if json.Unmarshal(input, &m) != nil || m == nil {
		m = map[string]any{}
	}
	m["answers"] = answers
	out, _ := json.Marshal(m)
	return out
}

// setModeIn returns the mode a set of permission updates switches to.
func setModeIn(updates []json.RawMessage) string {
	for _, u := range updates {
		var f struct {
			Type string `json:"type"`
			Mode string `json:"mode"`
		}
		if json.Unmarshal(u, &f) == nil && f.Type == "setMode" {
			return f.Mode
		}
	}
	return ""
}

// contentText flattens tool_result content: a string or text blocks.
func contentText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return string(raw)
	}
	var parts []string
	for _, b := range blocks {
		switch b.Type {
		case "text":
			parts = append(parts, b.Text)
		case "image":
			parts = append(parts, "[image]")
		}
	}
	return strings.Join(parts, "\n")
}

func clipText(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return strings.ToValidUTF8(s[:max], "") + fmt.Sprintf("\n… [%d more bytes]", len(s)-max)
}

// clipJSON bounds a tool input for the log and the wire: long strings (file
// contents, big commands) are cut, and anything still too big becomes a
// preview.
func clipJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) <= maxInputBytes {
		return raw
	}
	var v any
	if json.Unmarshal(raw, &v) == nil {
		if out, err := json.Marshal(clipStrings(v)); err == nil && len(out) <= maxInputBytes {
			return out
		}
	}
	out, _ := json.Marshal(map[string]any{"truncated": true, "preview": clipText(string(raw), maxInputString)})
	return out
}

func clipStrings(v any) any {
	switch t := v.(type) {
	case string:
		return clipText(t, maxInputString)
	case []any:
		for i := range t {
			t[i] = clipStrings(t[i])
		}
	case map[string]any:
		for k := range t {
			t[k] = clipStrings(t[k])
		}
	}
	return v
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
