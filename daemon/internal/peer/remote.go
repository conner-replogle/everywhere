package peer

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

const (
	remoteEventsDefault = 40
	remoteEventsMax     = 500
	remoteWaitMax       = 50 * time.Second
	remoteTermDefault   = 16 << 10
	remoteTermMax       = 256 << 10
	// The size of a shell an agent starts by typing into it.
	remoteCols, remoteRows = 120, 32
)

// Remote answers requests the hub relays from agents using the account's
// MCP endpoint, which have no WebRTC connection. It serves the control
// methods, plus reading and driving threads (what the agent and term
// channels do for a browser).
func (s *Server) Remote(method string, raw json.RawMessage) (any, error) {
	switch method {
	case "debug.peer", "device.update", "desktop.info", "desktop.start", "desktop.candidate", "desktop.stop":
		// Remote desktop is only for signed-in browsers, never MCP agents.
		return nil, fmt.Errorf("%s isn't available remotely", method)
	case "agent.read":
		return s.remoteAgentRead(raw)
	case "agent.request":
		var p struct {
			ThreadID string                  `json:"threadId"`
			Msg      protocol.AgentClientMsg `json:"msg"`
		}
		if err := unmarshal(raw, &p); err != nil {
			return nil, err
		}
		if _, err := s.claudeThread(p.ThreadID); err != nil {
			return nil, err
		}
		if err := s.agents.Request(p.ThreadID, p.Msg); err != nil {
			return nil, err
		}
		return empty{}, nil
	case "term.read":
		return s.remoteTermRead(raw)
	case "term.write":
		var p struct {
			ThreadID string `json:"threadId"`
			Text     string `json:"text"`
		}
		if err := unmarshal(raw, &p); err != nil {
			return nil, err
		}
		t, err := s.thread(p.ThreadID)
		if err != nil {
			return nil, err
		}
		if t.Kind != protocol.ThreadTerminal {
			return nil, errors.New("not a terminal thread")
		}
		if t.ArchivedAt != nil {
			return nil, errors.New("this thread is archived; restore it first")
		}
		if err := s.terms.Type(p.ThreadID, []byte(p.Text), remoteCols, remoteRows); err != nil {
			return nil, err
		}
		return empty{}, nil
	case "threads.get":
		var p struct {
			ThreadID string `json:"threadId"`
		}
		if err := unmarshal(raw, &p); err != nil {
			return nil, err
		}
		t, err := s.thread(p.ThreadID)
		if err != nil {
			return nil, err
		}
		s.fillStatus(&t)
		return t, nil
	case "threads.search":
		var p struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		if err := unmarshal(raw, &p); err != nil {
			return nil, err
		}
		return s.store.SearchAgentEvents(p.Query, min(max(p.Limit, 1), 50))
	}
	return s.call(method, raw)
}

func unmarshal(raw json.RawMessage, v any) error {
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return fmt.Errorf("bad params: %w", err)
	}
	return nil
}

func (s *Server) thread(id string) (protocol.Thread, error) {
	t, err := s.store.GetThread(id)
	if errors.Is(err, store.ErrNotFound) {
		return t, errors.New("thread not found")
	}
	return t, err
}

func (s *Server) claudeThread(id string) (protocol.Thread, error) {
	t, err := s.thread(id)
	if err != nil {
		return t, err
	}
	if t.Kind != protocol.ThreadClaude {
		return t, errors.New("not a claude thread")
	}
	return t, nil
}

// AgentRead is what agent.read returns: a claude thread, its live state and
// a page of its log, oldest first.
type AgentRead struct {
	Thread protocol.Thread             `json:"thread"`
	State  protocol.AgentState         `json:"state"`
	Events []protocol.AgentLoggedEvent `json:"events"`
	// More: there are older events before the first one here.
	More bool `json:"more"`
	// LastSeq is the newest event's seq, for afterSeq next time.
	LastSeq int64 `json:"lastSeq"`
}

// remoteAgentRead reads a claude thread: the newest limit events after
// afterSeq (and before beforeSeq, if set). With waitMs, it first waits up
// to that long for a turn in progress to finish or block on a prompt.
func (s *Server) remoteAgentRead(raw json.RawMessage) (any, error) {
	var p struct {
		ThreadID  string `json:"threadId"`
		AfterSeq  int64  `json:"afterSeq"`
		BeforeSeq int64  `json:"beforeSeq"`
		Limit     int    `json:"limit"`
		WaitMs    int64  `json:"waitMs"`
	}
	if err := unmarshal(raw, &p); err != nil {
		return nil, err
	}
	t, err := s.claudeThread(p.ThreadID)
	if err != nil {
		return nil, err
	}
	if wait := min(time.Duration(p.WaitMs)*time.Millisecond, remoteWaitMax); wait > 0 {
		deadline := time.Now().Add(wait)
		for time.Now().Before(deadline) {
			if _, status := s.agents.Status(t.ID); status != "starting" && status != "working" {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	limit := p.Limit
	if limit <= 0 {
		limit = remoteEventsDefault
	}
	events, more, err := s.store.AgentEvents(t.ID, p.AfterSeq, p.BeforeSeq, min(limit, remoteEventsMax))
	if err != nil {
		return nil, err
	}
	st, err := s.agents.State(t.ID)
	if err != nil {
		return nil, err
	}
	// Every client gets these from device.info and agent.info instead.
	st.Models, st.Commands = nil, nil
	s.fillStatus(&t)
	out := AgentRead{Thread: t, State: st, Events: make([]protocol.AgentLoggedEvent, len(events)), More: more}
	for i, e := range events {
		out.Events[i] = protocol.AgentLoggedEvent{Seq: e.Seq, At: e.At, Event: e.Event}
		out.LastSeq = e.Seq
	}
	return out, nil
}

// TermRead is what term.read returns: a terminal thread and the end of its
// scrollback as plain text.
type TermRead struct {
	Thread protocol.Thread `json:"thread"`
	Output string          `json:"output"`
	// Truncated: there was more scrollback than maxBytes.
	Truncated bool `json:"truncated"`
}

func (s *Server) remoteTermRead(raw json.RawMessage) (any, error) {
	var p struct {
		ThreadID string `json:"threadId"`
		MaxBytes int    `json:"maxBytes"`
	}
	if err := unmarshal(raw, &p); err != nil {
		return nil, err
	}
	t, err := s.thread(p.ThreadID)
	if err != nil {
		return nil, err
	}
	if t.Kind != protocol.ThreadTerminal {
		return nil, errors.New("not a terminal thread")
	}
	s.fillStatus(&t)
	limit := p.MaxBytes
	if limit <= 0 {
		limit = remoteTermDefault
	}
	text := plainText(s.terms.Scrollback(t.ID))
	out := TermRead{Thread: t, Output: text}
	if over := len(text) - min(limit, remoteTermMax); over > 0 {
		cut := over
		for cut < len(text) && !utf8.RuneStart(text[cut]) {
			cut++
		}
		out.Output, out.Truncated = text[cut:], true
	}
	return out, nil
}

// Escape sequences: CSI, OSC (ended by BEL or ST), and other two-byte ESC
// sequences, plus charset selection.
var ansiRe = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[@-_]`)

// plainText turns terminal output into roughly what the screen shows as
// text: escape sequences dropped, and a carriage return overwriting its line.
func plainText(b []byte) string {
	text := ansiRe.ReplaceAllString(strings.ToValidUTF8(string(b), "�"), "")
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	for i, l := range lines {
		if j := strings.LastIndexByte(strings.TrimRight(l, "\r"), '\r'); j >= 0 {
			l = l[j+1:]
		}
		// Apply backspaces.
		if strings.ContainsRune(l, '\b') {
			var out []rune
			for _, r := range l {
				if r == '\b' {
					if len(out) > 0 {
						out = out[:len(out)-1]
					}
					continue
				}
				out = append(out, r)
			}
			l = string(out)
		}
		lines[i] = strings.TrimRight(strings.Map(func(r rune) rune {
			if r < 0x20 && r != '\t' {
				return -1
			}
			return r
		}, l), " ")
	}
	return strings.Join(lines, "\n")
}
