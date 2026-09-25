// Package claude drives the Claude Code CLI over its stream-json protocol:
// the one the TypeScript Agent SDK (@anthropic-ai/claude-agent-sdk) speaks.
// Frames are newline-delimited JSON on stdin/stdout. User prompts go in as
// "user" frames, SDK messages come out, and both sides exchange
// control_request/control_response frames for initialize, permission
// prompts (can_use_tool), interrupts and mode/model changes.
//
// The protocol is internal to Claude Code rather than a published API, so
// everything that depends on its shape lives in this package. The reference
// is the SDK's sdk.d.ts.
package claude

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ErrExited is returned by calls made after the CLI process has exited.
var ErrExited = errors.New("claude: process exited")

const stderrTail = 8 << 10

// closeTimeout is how long Close waits after each step before escalating.
var closeTimeout = 3 * time.Second

type Options struct {
	Binary string // path to the claude executable; "" means "claude" on PATH
	Dir    string
	Env    []string // nil inherits the daemon's environment
	Model  string
	// PermissionMode is default | acceptEdits | plan | auto | dontAsk |
	// bypassPermissions.
	PermissionMode string
	Resume         string // session id to resume
	// ResumeAt, with Resume, resumes only up to and including this transcript
	// entry: the conversation is rolled back to it.
	ResumeAt string
	// ForkSession, with Resume, continues in a new session (its id comes
	// with the init message) and leaves the resumed one as it was.
	ForkSession bool
	SessionID   string // id for a new session (a UUID); ignored with Resume
	// FileCheckpointing backs up files before claude's edits, so RewindFiles
	// can restore them.
	FileCheckpointing bool
	AddDirs           []string // extra directories tools may access
	// Settings go into the session's flag settings layer (--settings), the
	// same layer ApplyFlagSettings changes mid-session.
	Settings map[string]any
	// PromptSuggestions asks for a predicted next prompt after each turn.
	PromptSuggestions bool
	Args              []string // extra CLI flags, appended last
}

// Session is one running CLI process.
type Session struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stderr *tailBuffer
	init   InitResponse

	writeMu sync.Mutex

	mu      sync.Mutex
	pending map[string]chan controlResult
	nextID  int
	queue   []Message
	wake    chan struct{}

	out       chan Message
	done      chan struct{}
	err       error
	closeOnce sync.Once
}

type controlResult struct {
	resp json.RawMessage
	err  error
}

// Start launches the CLI and completes the initialize handshake.
func Start(ctx context.Context, o Options) (*Session, error) {
	bin := o.Binary
	if bin == "" {
		bin = "claude"
	}
	cmd := exec.Command(bin, buildArgs(o)...)
	cmd.Dir = o.Dir
	cmd.Env = o.Env
	if cmd.Env == nil {
		cmd.Env = os.Environ()
	}
	if !hasEnv(cmd.Env, "CLAUDE_CODE_ENTRYPOINT") {
		cmd.Env = append(cmd.Env, "CLAUDE_CODE_ENTRYPOINT=sdk-go")
	}
	if o.FileCheckpointing {
		cmd.Env = append(cmd.Env, "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true")
	}
	// Own process group, so Close can take down tool subprocesses too.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	s := &Session{
		cmd:     cmd,
		stderr:  &tailBuffer{max: stderrTail},
		pending: map[string]chan controlResult{},
		wake:    make(chan struct{}, 1),
		out:     make(chan Message),
		done:    make(chan struct{}),
	}
	cmd.Stderr = s.stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	s.stdin = stdin
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("claude: start %s: %w", bin, err)
	}

	readerDone := make(chan struct{})
	go func() {
		s.read(stdout)
		close(readerDone)
	}()
	go func() {
		<-readerDone
		err := cmd.Wait()
		s.mu.Lock()
		s.err = s.exitError(err)
		s.mu.Unlock()
		close(s.done)
		s.signal()
	}()
	go s.pump()

	resp, err := s.control(ctx, map[string]any{"subtype": "initialize", "promptSuggestions": o.PromptSuggestions})
	if err != nil {
		s.abort()
		if exitErr := s.Err(); errors.Is(err, ErrExited) && exitErr != nil {
			err = exitErr // carries the stderr tail, e.g. a bad flag
		}
		return nil, fmt.Errorf("claude: initialize: %w", err)
	}
	if err := json.Unmarshal(resp, &s.init); err != nil {
		s.abort()
		return nil, fmt.Errorf("claude: initialize response: %w", err)
	}
	s.init.Raw = resp
	return s, nil
}

func buildArgs(o Options) []string {
	args := []string{
		"--output-format", "stream-json", "--verbose",
		"--input-format", "stream-json",
		"--permission-prompt-tool", "stdio",
		"--include-partial-messages",
	}
	if o.Model != "" {
		args = append(args, "--model", o.Model)
	}
	if o.PermissionMode != "" {
		args = append(args, "--permission-mode", o.PermissionMode)
		if o.PermissionMode == "bypassPermissions" {
			args = append(args, "--allow-dangerously-skip-permissions")
		}
	}
	if o.Resume != "" {
		args = append(args, "--resume", o.Resume)
		if o.ResumeAt != "" {
			args = append(args, "--resume-session-at", o.ResumeAt)
		}
		if o.ForkSession {
			args = append(args, "--fork-session")
		}
	} else if o.SessionID != "" {
		args = append(args, "--session-id", o.SessionID)
	}
	for _, d := range o.AddDirs {
		args = append(args, "--add-dir", d)
	}
	if len(o.Settings) > 0 {
		b, _ := json.Marshal(o.Settings)
		args = append(args, "--settings", string(b))
	}
	return append(args, o.Args...)
}

// Init returns the initialize response: account, models, slash commands.
func (s *Session) Init() InitResponse { return s.init }

// Messages delivers everything the CLI emits, in order, and must be drained.
// It is closed after the process exits and every message has been
// delivered; Err then reports why. Control calls never wait on it, so it's
// safe to call Interrupt or Respond from the goroutine that drains it.
func (s *Session) Messages() <-chan Message { return s.out }

// Done is closed when the process exits.
func (s *Session) Done() <-chan struct{} { return s.done }

// Err reports why the process exited: nil for a clean exit.
func (s *Session) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

// Send queues a prompt. Sent while a turn is running, it's folded into that
// turn at the next opportunity instead of starting a new one.
func (s *Session) Send(m UserMessage) error {
	frame := map[string]any{
		"type":               "user",
		"message":            map[string]any{"role": "user", "content": m.Content},
		"parent_tool_use_id": nil,
	}
	if m.UUID != "" {
		frame["uuid"] = m.UUID
	}
	return s.write(frame)
}

// Respond answers a permission prompt.
func (s *Session) Respond(req *PermissionRequest, res PermissionResult) error {
	if res.Behavior == "allow" && res.UpdatedInput == nil {
		res.UpdatedInput = req.Input
	}
	if res.Behavior == "deny" && res.Message == "" {
		res.Message = "The user denied this tool use."
	}
	res.ToolUseID = req.ToolUseID
	return s.write(map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"subtype":    "success",
			"request_id": req.ID,
			"response":   res,
		},
	})
}

// Interrupt stops the running turn. The CLI answers once the abort is
// underway; the turn's result message follows.
func (s *Session) Interrupt(ctx context.Context) error {
	_, err := s.control(ctx, map[string]any{"subtype": "interrupt", "cancel_queued": true})
	return err
}

func (s *Session) SetPermissionMode(ctx context.Context, mode string) error {
	_, err := s.control(ctx, map[string]any{"subtype": "set_permission_mode", "mode": mode})
	return err
}

// ApplyFlagSettings merges settings into the session's flag settings layer,
// e.g. effortLevel or alwaysThinkingEnabled. A nil value clears a key.
func (s *Session) ApplyFlagSettings(ctx context.Context, settings map[string]any) error {
	_, err := s.control(ctx, map[string]any{"subtype": "apply_flag_settings", "settings": settings})
	return err
}

// Usage returns what /usage shows: the plan's rate-limit windows and the
// session's totals. The shape is experimental upstream.
func (s *Session) Usage(ctx context.Context) (Usage, error) {
	resp, err := s.control(ctx, map[string]any{"subtype": "get_usage", "skip_behaviors": true})
	if err != nil {
		return Usage{}, err
	}
	var u Usage
	err = json.Unmarshal(resp, &u)
	return u, err
}

// ContextUsage reports how full the context window is. It answers from the
// last response's usage and local estimates, without API calls.
func (s *Session) ContextUsage(ctx context.Context) (ContextUsage, error) {
	resp, err := s.control(ctx, map[string]any{"subtype": "get_context_usage", "detail": "summary"})
	if err != nil {
		return ContextUsage{}, err
	}
	var u ContextUsage
	err = json.Unmarshal(resp, &u)
	return u, err
}

// GenerateTitle asks claude to name the session after description. With
// persist, claude saves the title to the transcript, and for the session's
// first prompt returns the title it generated (or is generating) for it
// instead of making another. "" means claude had nothing to go on.
func (s *Session) GenerateTitle(ctx context.Context, description string, persist bool) (string, error) {
	resp, err := s.control(ctx, map[string]any{
		"subtype":     "generate_session_title",
		"description": description,
		"persist":     persist,
	})
	if err != nil {
		return "", err
	}
	var r struct {
		Title *string `json:"title"`
	}
	if err := json.Unmarshal(resp, &r); err != nil || r.Title == nil {
		return "", err
	}
	return *r.Title, nil
}

// RewindFiles restores the files claude edited since the prompt with the
// given UUID to how they were when it was sent. It needs FileCheckpointing
// on for the whole session; dryRun only reports what would change.
func (s *Session) RewindFiles(ctx context.Context, userMessageID string, dryRun bool) (RewindFilesResult, error) {
	resp, err := s.control(ctx, map[string]any{
		"subtype":         "rewind_files",
		"user_message_id": userMessageID,
		"dry_run":         dryRun,
	})
	if err != nil {
		return RewindFilesResult{}, err
	}
	var r RewindFilesResult
	err = json.Unmarshal(resp, &r)
	return r, err
}

func (s *Session) SetModel(ctx context.Context, model string) error {
	_, err := s.control(ctx, map[string]any{"subtype": "set_model", "model": model})
	return err
}

// Close ends the session. It closes stdin so the CLI can exit on its own,
// then signals the process group with SIGTERM and finally SIGKILL. Safe to
// call more than once and concurrently.
func (s *Session) Close() {
	s.closeOnce.Do(func() {
		s.writeMu.Lock()
		_ = s.stdin.Close()
		s.writeMu.Unlock()
		pid := s.cmd.Process.Pid
		for _, sig := range []syscall.Signal{syscall.SIGTERM, syscall.SIGKILL} {
			select {
			case <-s.done:
				return
			case <-time.After(closeTimeout):
			}
			_ = syscall.Kill(-pid, sig)
		}
	})
	<-s.done
}

// abort closes a session that Start is giving up on; nobody else will drain
// its messages.
func (s *Session) abort() {
	go func() {
		for range s.out {
		}
	}()
	s.Close()
}

func (s *Session) control(ctx context.Context, req map[string]any) (json.RawMessage, error) {
	ch := make(chan controlResult, 1)
	s.mu.Lock()
	if s.isDone() {
		s.mu.Unlock()
		return nil, ErrExited
	}
	s.nextID++
	id := fmt.Sprintf("ew-%d", s.nextID)
	s.pending[id] = ch
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.pending, id)
		s.mu.Unlock()
	}()

	if err := s.write(map[string]any{"type": "control_request", "request_id": id, "request": req}); err != nil {
		return nil, err
	}
	select {
	case r := <-ch:
		return r.resp, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-s.done:
		return nil, ErrExited
	}
}

func (s *Session) write(frame any) error {
	b, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.isDone() {
		return ErrExited
	}
	if _, err := s.stdin.Write(append(b, '\n')); err != nil {
		return fmt.Errorf("claude: write: %w", err)
	}
	return nil
}

func (s *Session) isDone() bool {
	select {
	case <-s.done:
		return true
	default:
		return false
	}
}

// read parses stdout until EOF. It never blocks on consumers: messages go
// into an unbounded queue drained by pump, so control responses keep
// flowing while the consumer is busy (e.g. waiting on Interrupt).
func (s *Session) read(stdout io.Reader) {
	r := bufio.NewReaderSize(stdout, 64<<10)
	for {
		line, err := r.ReadBytes('\n')
		if line = bytes.TrimSpace(line); len(line) > 0 {
			s.handleLine(line)
		}
		if err != nil {
			return
		}
	}
}

func (s *Session) handleLine(line []byte) {
	var m Message
	if err := json.Unmarshal(line, &m); err != nil {
		slog.Debug("claude: skipping non-JSON output", "line", lastN(string(line), 200))
		return
	}
	m.Raw = line

	switch m.Type {
	case "control_response":
		var f struct {
			Response struct {
				Subtype   string          `json:"subtype"`
				RequestID string          `json:"request_id"`
				Response  json.RawMessage `json:"response"`
				Error     string          `json:"error"`
			} `json:"response"`
		}
		if json.Unmarshal(line, &f) != nil {
			return
		}
		r := controlResult{resp: f.Response.Response}
		if f.Response.Subtype == "error" {
			r = controlResult{err: fmt.Errorf("claude: %s", f.Response.Error)}
		}
		s.mu.Lock()
		ch := s.pending[f.Response.RequestID]
		s.mu.Unlock()
		if ch != nil {
			ch <- r
		}
		return

	case "control_request":
		var f struct {
			RequestID string `json:"request_id"`
			Request   struct {
				Subtype string `json:"subtype"`
			} `json:"request"`
		}
		if json.Unmarshal(line, &f) != nil {
			return
		}
		if f.Request.Subtype != "can_use_tool" {
			// Hooks, SDK MCP servers and dialogs are host features we don't
			// offer; refuse so the CLI falls back instead of waiting.
			s.refuse(f.RequestID, f.Request.Subtype)
			return
		}
		var p struct {
			Request PermissionRequest `json:"request"`
		}
		if json.Unmarshal(line, &p) != nil {
			s.refuse(f.RequestID, f.Request.Subtype)
			return
		}
		p.Request.ID = f.RequestID
		m.Subtype = "can_use_tool"
		m.Permission = &p.Request

	case "control_cancel_request":
		var f struct {
			RequestID string `json:"request_id"`
		}
		if json.Unmarshal(line, &f) != nil {
			return
		}
		m.CanceledRequestID = f.RequestID
	}
	s.enqueue(m)
}

func (s *Session) refuse(requestID, subtype string) {
	_ = s.write(map[string]any{
		"type": "control_response",
		"response": map[string]any{
			"subtype":    "error",
			"request_id": requestID,
			"error":      fmt.Sprintf("unsupported control request %q", subtype),
		},
	})
}

func (s *Session) enqueue(m Message) {
	s.mu.Lock()
	s.queue = append(s.queue, m)
	s.mu.Unlock()
	s.signal()
}

func (s *Session) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// pump moves queued messages to the out channel, closing it after the
// process has exited and the queue is empty.
func (s *Session) pump() {
	for {
		s.mu.Lock()
		batch := s.queue
		s.queue = nil
		exited := s.isDone()
		s.mu.Unlock()
		for _, m := range batch {
			s.out <- m
		}
		if len(batch) == 0 {
			if exited {
				close(s.out)
				return
			}
			<-s.wake
		}
	}
}

func (s *Session) exitError(err error) error {
	if err == nil {
		return nil
	}
	if tail := strings.TrimSpace(s.stderr.String()); tail != "" {
		return fmt.Errorf("claude: %w: %s", err, lastN(tail, 2000))
	}
	return fmt.Errorf("claude: %w", err)
}

func hasEnv(env []string, key string) bool {
	for _, kv := range env {
		if strings.HasPrefix(kv, key+"=") {
			return true
		}
	}
	return false
}

func lastN(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

// tailBuffer keeps the last max bytes written to it.
type tailBuffer struct {
	mu  sync.Mutex
	max int
	buf []byte
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = append(b.buf, p...)
	if over := len(b.buf) - b.max; over > 0 {
		b.buf = b.buf[over:]
	}
	return len(p), nil
}

func (b *tailBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.buf)
}
