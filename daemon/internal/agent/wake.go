package agent

// Wakes: a thread's agent can ask to be woken later (thread_wake), to check
// on something with no process to wait on, or to work on a schedule. At
// the time, the message joins the turn in progress or starts one, as a
// process event that asked to wake does. One wake per thread; a new one
// replaces it. It's stored, so it survives a restart.

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/claude"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

const (
	// MinWake and MaxWake bound how far ahead a wake can be.
	MinWake = time.Minute
	MaxWake = 7 * 24 * time.Hour
)

// ScheduleWake wakes the thread's agent after in, for reason; in == 0
// cancels its wake. It returns when the wake is.
func (m *Manager) ScheduleWake(threadID string, in time.Duration, reason string) (time.Time, error) {
	if in != 0 && (in < m.minWake() || in > MaxWake) {
		return time.Time{}, fmt.Errorf("a wake must be between %s and %s ahead", MinWake, MaxWake)
	}
	reason = strings.TrimSpace(reason)
	if in != 0 && reason == "" {
		return time.Time{}, errors.New("say what the wake is for in reason")
	}
	s, err := m.session(threadID)
	if err != nil {
		return time.Time{}, err
	}
	at := time.Now().Add(in)
	ran := false
	s.call(func() {
		ran = true
		if in == 0 {
			s.setWake(nil)
		} else {
			s.setWake(&protocol.AgentWake{At: at.UnixMilli(), Reason: clipText(reason, goalReasonBytes)})
		}
		s.changed()
	})
	if !ran {
		return time.Time{}, errClosed
	}
	return at, nil
}

// setWake stores w (nil: none), arms its timer and says so in the timeline.
func (s *session) setWake(w *protocol.AgentWake) {
	had := s.state.Wake != nil
	s.state.Wake = w
	var raw json.RawMessage
	if w != nil {
		raw, _ = json.Marshal(w)
	}
	if err := s.m.store.SetAgentWake(s.threadID, raw); err != nil {
		slog.Warn("saving wake", "thread", s.threadID, "err", err)
	}
	s.armWake()
	switch {
	case w != nil:
		at := time.UnixMilli(w.At)
		s.emit(protocol.AgentEvent{Type: "notice", Kind: "wake", Text: fmt.Sprintf(
			"%s wakes at %s (in %s): %s", s.name(), at.Format("15:04"), time.Until(at).Round(time.Minute), w.Reason)})
	case had:
		s.emit(protocol.AgentEvent{Type: "notice", Kind: "wake", Text: "Wake canceled"})
	}
}

// armWake sets the timer for state.Wake, if any; one already past fires
// right away.
func (s *session) armWake() {
	if s.wakeTimer != nil {
		s.wakeTimer.Stop()
		s.wakeTimer = nil
	}
	w := s.state.Wake
	if w == nil {
		return
	}
	var t *time.Timer
	t = time.AfterFunc(max(time.Until(time.UnixMilli(w.At)), 0), func() {
		s.do(func() {
			if s.wakeTimer != t {
				return
			}
			s.wakeTimer = nil
			s.wakeFired()
		})
	})
	s.wakeTimer = t
}

// wakeFired delivers the wake: into the turn in progress, or a new turn.
func (s *session) wakeFired() {
	w := s.state.Wake
	if w == nil {
		return
	}
	s.state.Wake = nil
	if err := s.m.store.SetAgentWake(s.threadID, nil); err != nil {
		slog.Warn("clearing wake", "thread", s.threadID, "err", err)
	}
	s.emit(protocol.AgentEvent{Type: "notice", Kind: "wake", Text: "Woke up as asked: " + w.Reason})
	prompt := fmt.Sprintf("<scheduled-wake>\nYou asked to be woken now (thread_wake): %s\n"+
		"This message is from Everywhere, not from the user.\n</scheduled-wake>", w.Reason)
	if s.turnActive && s.proc != nil {
		if err := s.proc.Send(claude.UserMessage{Content: []claude.ContentBlock{claude.Text(prompt)}}); err != nil {
			slog.Warn("sending wake", "thread", s.threadID, "err", err)
			s.held = append(s.held, prompt)
		}
		s.changed()
		return
	}
	s.held = append(s.held, prompt)
	if err := s.ensureProc(); err != nil {
		s.emit(protocol.AgentEvent{Type: "notice", Text: fmt.Sprintf("Couldn't start %s for its wake: %v", s.name(), err)})
		s.changed()
		return
	}
	s.beginTurn()
	if err := s.proc.Send(claude.UserMessage{Content: s.heldBlocks()}); err != nil {
		slog.Warn("sending wake", "thread", s.threadID, "err", err)
	} else {
		s.held = nil
	}
	s.changed()
}

func (m *Manager) minWake() time.Duration {
	if m.wakeMin > 0 {
		return m.wakeMin
	}
	return MinWake
}

// loadWake reads a stored wake; a broken one is dropped.
func loadWake(raw json.RawMessage) *protocol.AgentWake {
	if raw == nil {
		return nil
	}
	w := new(protocol.AgentWake)
	if json.Unmarshal(raw, w) != nil || w.At == 0 {
		return nil
	}
	return w
}
