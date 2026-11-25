package agent

// Goal mode: a thread with a goal keeps working without the user. When a
// turn ends and the goal is still active, the session starts another one
// with a continuation prompt, until the agent reports the goal complete or
// blocked (goal_update), the user pauses it, or a limit does: a stopped or
// failed turn, goalStallLimit turns in a row without a tool call, or the
// goal's MaxTurns. An agent waiting on a process it started with notify
// says so (status waiting) and the process's event wakes it, as any
// process event does; GoalWaitTimeout bounds the wait. A claim that the
// goal is complete is checked first: the next turn audits it against fresh
// evidence, and only a claim made in that turn completes the goal (the
// part of a judge, with no second model).
//
// The goal is the daemon's, not the agent's, so it works the same for
// claude and for agents run through a harness. This follows Codex's goal
// extension (codex-rs/ext/goal) and OpenCode's goal plugin.

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
	// DefaultGoalMaxTurns is a goal's turn budget when it's set without one,
	// and what resuming a limited goal adds.
	DefaultGoalMaxTurns = 50
	// goalStallLimit pauses a goal after this many turns in a row with no
	// tool call: the agent is talking, not working.
	goalStallLimit = 3
	// maxGoalObjective caps an objective, in bytes.
	maxGoalObjective = 4000
	// goalReasonBytes caps a reason shown with a goal.
	goalReasonBytes = 500
)

// goalCommand runs a goal request from the user: set (objective, with
// maxTurns or the default), pause, resume or clear.
func (s *session) goalCommand(action, objective string, maxTurns int) error {
	g := s.state.Goal
	switch action {
	case "set":
		objective = strings.TrimSpace(objective)
		if objective == "" {
			return errors.New("a goal needs an objective")
		}
		if len(objective) > maxGoalObjective {
			return fmt.Errorf("a goal's objective can be at most %d characters", maxGoalObjective)
		}
		if maxTurns <= 0 {
			maxTurns = s.m.goalMaxTurns()
		}
		now := time.Now().UnixMilli()
		s.cancelGoalTimer()
		s.saveGoal(&protocol.AgentGoal{
			Objective: objective, Status: protocol.GoalActive, MaxTurns: maxTurns, SetAt: now, UpdatedAt: now,
		})
		s.goalNotice(protocol.GoalActive, "Goal set: "+objective)
		if !s.turnActive {
			s.goalTurn(goalKickoff(s.state.Goal))
		}
		// During a turn, the goal takes over when it ends.
	case "pause":
		if !goalRunning(g) {
			return errors.New("this thread has no active goal to pause")
		}
		s.cancelGoalTimer()
		s.updateGoal(func(g *protocol.AgentGoal) { g.Status, g.Reason = protocol.GoalPaused, "Paused by you" })
		s.goalNotice(protocol.GoalPaused, "Goal paused; the current turn, if any, finishes")
	case "resume":
		if g == nil {
			return errors.New("this thread has no goal to resume")
		}
		if goalRunning(g) {
			return nil
		}
		if g.Status == protocol.GoalComplete {
			return errors.New("this goal is complete; set a new one")
		}
		s.updateGoal(func(g *protocol.AgentGoal) {
			if g.Turns >= g.MaxTurns {
				g.MaxTurns = g.Turns + s.m.goalMaxTurns()
			}
			g.Status, g.Reason, g.Stalls = protocol.GoalActive, "", 0
		})
		s.goalNotice(protocol.GoalActive, "Goal resumed")
		if !s.turnActive {
			s.goalTurn(s.goalPrompt("The user resumed the goal."))
		}
	case "clear":
		if g == nil {
			return errors.New("this thread has no goal")
		}
		s.cancelGoalTimer()
		s.saveGoal(nil)
		s.goalNotice("cleared", "Goal cleared")
	default:
		return fmt.Errorf("unknown goal action %q", action)
	}
	return nil
}

// goalSlashCommand runs /goal typed as a prompt: "/goal" shows the goal,
// "/goal pause|resume|clear" act on it and anything else sets it. It
// reports whether text was a /goal command.
func (s *session) goalSlashCommand(text string) (bool, error) {
	rest, ok := strings.CutPrefix(text, "/goal")
	if !ok || (rest != "" && !strings.ContainsAny(rest[:1], " \t\n")) {
		return false, nil
	}
	arg := strings.TrimSpace(rest)
	switch strings.ToLower(arg) {
	case "":
		s.goalNotice("", describeGoal(s.state.Goal))
		return true, nil
	case "pause":
		return true, s.goalCommand("pause", "", 0)
	case "resume":
		return true, s.goalCommand("resume", "", 0)
	case "clear", "stop", "off", "cancel", "reset", "none":
		return true, s.goalCommand("clear", "", 0)
	}
	return true, s.goalCommand("set", arg, 0)
}

// goalAfterTurn moves the goal on when a turn ends (ev is its turn event)
// and reports whether it keeps going, so the turn's end isn't announced as
// the thread finishing. recap: the turn was only a /recap.
func (s *session) goalAfterTurn(ev protocol.AgentEvent, recap bool) bool {
	g := s.state.Goal
	if !goalRunning(g) {
		return false
	}
	if recap {
		// A continuation (or the end of a wait) that came due during a
		// /recap found it running.
		if s.goalTimer == nil {
			s.scheduleGoalTurn(s.m.goalDelay(), "")
		}
		return true
	}
	switch ev.Status {
	case "interrupted":
		s.pauseGoal("The turn was stopped")
		return false
	case "error":
		if ev.Kind == "refreshBusy" {
			return true // retried by scheduleRefreshRetry; the goal goes on after
		}
		reason := "The turn failed"
		if t := strings.TrimSpace(ev.Text); t != "" {
			reason += ": " + t
		}
		s.pauseGoal(reason)
		return false
	}
	s.updateGoal(func(g *protocol.AgentGoal) {
		if s.turnTools == 0 {
			g.Stalls++
		} else {
			g.Stalls = 0
		}
	})
	g = s.state.Goal
	switch {
	case g.Audit == "running":
		// The audit turn ended without confirming: back to work, and the
		// next claim is checked again.
		s.updateGoal(func(g *protocol.AgentGoal) { g.Audit = "" })
	case g.Audit == "due":
		// Checked even past MaxTurns: it's one turn, and the last word.
		s.scheduleGoalTurn(s.m.goalDelay(), "")
		return true
	}
	g = s.state.Goal
	switch {
	case g.Status == protocol.GoalWaiting:
		s.scheduleGoalTurn(s.m.goalWaitTimeout(), fmt.Sprintf(
			"You were waiting (%s), and nothing woke you for %s. Check on what you were waiting for.",
			g.Reason, s.m.goalWaitTimeout().Round(time.Second)))
		return true
	case g.Stalls >= goalStallLimit:
		s.pauseGoal(fmt.Sprintf("No progress: %d turns in a row without using a tool", g.Stalls))
		return false
	case g.Turns >= g.MaxTurns:
		s.updateGoal(func(g *protocol.AgentGoal) {
			g.Status, g.Reason = protocol.GoalLimited, fmt.Sprintf("Used its %d turns", g.MaxTurns)
		})
		s.goalNotice(protocol.GoalLimited, fmt.Sprintf("Goal stopped after %d turns; resume it to give it %d more", g.MaxTurns, s.m.goalMaxTurns()))
		return false
	}
	s.scheduleGoalTurn(s.m.goalDelay(), "")
	return true
}

// goalTurnBegan is beginTurn's part: any turn ends a wait and the pending
// continuation (a wake, a prompt or the continuation itself is that turn).
// A /recap leaves both alone.
func (s *session) goalTurnBegan() {
	if s.recapping {
		return
	}
	s.cancelGoalTimer()
	s.turnTools = 0
	s.goalNotify = ""
	if g := s.state.Goal; g != nil && g.Status == protocol.GoalWaiting {
		s.updateGoal(func(g *protocol.AgentGoal) { g.Status, g.Reason = protocol.GoalActive, "" })
	}
}

// scheduleGoalTurn starts the goal's next turn after wait, unless a turn
// starts first or the goal stops. note, if any, tells the agent why.
func (s *session) scheduleGoalTurn(wait time.Duration, note string) {
	s.cancelGoalTimer()
	var t *time.Timer
	t = time.AfterFunc(wait, func() {
		s.do(func() {
			if s.goalTimer != t {
				return // canceled, or a turn started meanwhile
			}
			s.goalTimer = nil
			if s.turnActive || !goalRunning(s.state.Goal) {
				return
			}
			s.goalTurn(s.goalPrompt(note))
		})
	})
	s.goalTimer = t
}

func (s *session) cancelGoalTimer() {
	if s.goalTimer != nil {
		s.goalTimer.Stop()
		s.goalTimer = nil
	}
}

// goalTurn starts a turn of the goal's with prompt (and any held process
// events). Turns are counted as they start, so a turn that never ends (the
// daemon crashing in it, say) still counts.
func (s *session) goalTurn(prompt string) {
	if err := s.ensureProc(); err != nil {
		s.pauseGoal(fmt.Sprintf("Couldn't start %s: %v", s.name(), err))
		s.changed()
		return
	}
	s.beginTurn()
	s.updateGoal(func(g *protocol.AgentGoal) {
		g.Turns++
		if g.Audit == "due" {
			g.Audit = "running"
		}
	})
	g := s.state.Goal
	text := fmt.Sprintf("Working toward the goal (turn %d of %d)", g.Turns, g.MaxTurns)
	if g.Audit == "running" {
		text = fmt.Sprintf("Checking the goal is complete (turn %d)", g.Turns)
	}
	s.emit(protocol.AgentEvent{Type: "notice", Kind: "goal", Status: g.Status, Text: text})
	content := append(s.heldBlocks(), claude.Text(prompt))
	if err := s.proc.Send(claude.UserMessage{Content: content}); err != nil {
		slog.Warn("sending goal turn", "thread", s.threadID, "err", err)
		s.endTurn(protocol.AgentEvent{Type: "turn", Status: "error", Text: err.Error()})
	} else {
		s.held = nil
	}
	s.changed()
}

// resumeGoal continues a running goal after the daemon started, when no
// interrupted turn is being continued (whose end continues the goal).
func (s *session) resumeGoal() {
	if s.turnActive || !goalRunning(s.state.Goal) {
		return
	}
	s.goalTurn(s.goalPrompt(
		"Everywhere restarted since your last turn. Processes you were waiting on may have ended or been stopped: check them."))
}

// goalPrompt is the goal's next turn's prompt: the audit of a claim that
// it's complete, if one is due, or else a continuation with note.
func (s *session) goalPrompt(note string) string {
	g := s.state.Goal
	if g.Audit == "due" {
		return goalAudit(g)
	}
	return goalContinuation(g, note)
}

// agentUpdateGoal is goal_update, from the thread's agent: complete,
// blocked or waiting (which needs a running process or a wake: something
// to wake it). It returns what to tell the agent.
func (s *session) agentUpdateGoal(status, reason string, processes bool) (string, error) {
	if !goalRunning(s.state.Goal) {
		return "", errors.New("this thread has no active goal")
	}
	reason = clipText(strings.TrimSpace(reason), goalReasonBytes)
	s.cancelGoalTimer()
	switch status {
	case protocol.GoalComplete:
		if s.state.Goal.Audit != "running" {
			s.updateGoal(func(g *protocol.AgentGoal) { g.Audit, g.Reason = "due", reason })
			s.goalNotice(protocol.GoalActive, prefixed("Reported complete; the next turn checks it", reason))
			return "Noted. Before the goal is marked complete, your next turn checks the claim against fresh evidence. " +
				"End this turn now without starting more work.", nil
		}
		s.updateGoal(func(g *protocol.AgentGoal) { g.Status, g.Reason, g.Audit = protocol.GoalComplete, reason, "" })
		s.goalNotice(protocol.GoalComplete, prefixed("Goal complete", reason))
		if s.turnActive {
			s.doneAfterTurn = true
		} else if err := s.setDone(); err != nil {
			slog.Warn("mark thread done", "thread", s.threadID, "err", err)
		}
		return "The goal is complete. Finish your reply with a short summary of what was done; don't start more work.", nil
	case protocol.GoalBlocked:
		if reason == "" {
			return "", errors.New("say what you need from the user in reason")
		}
		s.updateGoal(func(g *protocol.AgentGoal) { g.Status, g.Reason = protocol.GoalBlocked, reason })
		s.goalNotice(protocol.GoalBlocked, prefixed("Goal blocked", reason))
		s.goalNotify = "question"
		return "The goal is blocked until the user answers. Say in your reply exactly what you need from them, then end your turn.", nil
	case protocol.GoalWaiting:
		if !processes && s.state.Wake == nil {
			return "", errors.New("nothing to wait on: none of this thread's processes is running and no wake is scheduled. " +
				"Start what you're waiting on with process_start and notify: true, schedule a wake with thread_wake, or keep working")
		}
		if reason == "" {
			reason = "waiting on a process"
		}
		s.updateGoal(func(g *protocol.AgentGoal) { g.Status, g.Reason = protocol.GoalWaiting, reason })
		s.goalNotice(protocol.GoalWaiting, prefixed("Waiting", reason))
		return fmt.Sprintf("Waiting. End your turn now: you'll be woken when a process you started with notify ends "+
			"or reaches a checkpoint, and in %s at the latest.", s.m.goalWaitTimeout().Round(time.Second)), nil
	}
	return "", fmt.Errorf("status must be complete, blocked or waiting, not %q", status)
}

func (s *session) pauseGoal(reason string) {
	s.cancelGoalTimer()
	s.updateGoal(func(g *protocol.AgentGoal) {
		g.Status, g.Reason = protocol.GoalPaused, reason
		if g.Audit == "running" {
			g.Audit = "due" // the audit didn't finish: it's done again on resuming
		}
	})
	s.goalNotice(protocol.GoalPaused, "Goal paused: "+reason)
}

// updateGoal changes a copy of the goal and saves it: state already sent
// to clients may still be being encoded, so the goal is never changed in
// place.
func (s *session) updateGoal(change func(*protocol.AgentGoal)) {
	if s.state.Goal == nil {
		return
	}
	g := *s.state.Goal
	change(&g)
	g.Reason = clipText(g.Reason, goalReasonBytes)
	g.UpdatedAt = time.Now().UnixMilli()
	s.saveGoal(&g)
}

// saveGoal stores g (nil: no goal) and makes it the state's.
func (s *session) saveGoal(g *protocol.AgentGoal) {
	s.state.Goal = g
	var raw json.RawMessage
	if g != nil {
		var err error
		if raw, err = json.Marshal(g); err != nil {
			return
		}
	}
	if err := s.m.store.SetAgentGoal(s.threadID, raw); err != nil {
		slog.Warn("saving goal", "thread", s.threadID, "err", err)
	}
}

func (s *session) goalNotice(status, text string) {
	s.emit(protocol.AgentEvent{Type: "notice", Kind: "goal", Status: status, Text: text})
}

// loadGoal reads a stored goal; a broken one is dropped.
func loadGoal(raw json.RawMessage) *protocol.AgentGoal {
	if raw == nil {
		return nil
	}
	g := new(protocol.AgentGoal)
	if json.Unmarshal(raw, g) != nil || g.Objective == "" {
		return nil
	}
	return g
}

// goalStatus is g's status, or "" for no goal.
func goalStatus(g *protocol.AgentGoal) string {
	if g == nil {
		return ""
	}
	return g.Status
}

// goalRunning: g keeps the agent going.
func goalRunning(g *protocol.AgentGoal) bool {
	return g != nil && (g.Status == protocol.GoalActive || g.Status == protocol.GoalWaiting)
}

func describeGoal(g *protocol.AgentGoal) string {
	if g == nil {
		return "No goal. Set one with /goal <objective>; then /goal pause, /goal resume or /goal clear."
	}
	text := fmt.Sprintf("Goal (%s, turn %d of %d): %s", g.Status, g.Turns, g.MaxTurns, g.Objective)
	if g.Reason != "" {
		text += "\n" + g.Reason
	}
	return text
}

func prefixed(prefix, reason string) string {
	if reason == "" {
		return prefix
	}
	return prefix + ": " + reason
}

func (m *Manager) goalMaxTurns() int {
	if m.GoalMaxTurns > 0 {
		return m.GoalMaxTurns
	}
	return DefaultGoalMaxTurns
}

func (m *Manager) goalDelay() time.Duration { return m.GoalDelay }

func (m *Manager) goalWaitTimeout() time.Duration {
	if m.GoalWaitTimeout > 0 {
		return m.GoalWaitTimeout
	}
	return 30 * time.Minute
}

// goalRules is how a goal's turns are told to work, after its objective.
const goalRules = `How to work toward a goal:
- Take the next concrete step and do it. Don't ask the user for anything you can find out or decide yourself: they aren't watching each turn.
- Before calling the goal complete, check every part of the objective against what you can see now (files, test output, process output). Something you believe but haven't checked isn't done. Then call goal_update with status "complete" and a one-line summary.
- To wait on something slow (a build, a test suite, a training run), start it with process_start and notify: true, then call goal_update with status "waiting" and end your turn. You're woken when it ends or reaches a checkpoint. Don't restart a process just because it's taking a while.
- Call goal_update with status "blocked" only when you can't go on without the user (a decision only they can make, access, credentials) and you've tried what you can. Say in your reply what you need.
- Otherwise just end your turn when you've made progress: the next one starts on its own. A turn that uses no tools counts as no progress; a few in a row pause the goal.`

func goalKickoff(g *protocol.AgentGoal) string {
	return fmt.Sprintf(`<goal>
The user set a goal for this thread. Work toward it on your own, over as many turns as it takes (up to %d): when your turn ends, the next one starts, until you report the goal complete or blocked.

Objective:
%s
</goal>

%s`, g.MaxTurns, g.Objective, goalRules)
}

func goalAudit(g *protocol.AgentGoal) string {
	return fmt.Sprintf(`<goal-audit turn="%d">
You reported this thread's goal complete: %q. Before it's marked complete, check the claim. This message is from Everywhere, not from the user.

Go through the objective requirement by requirement, and for each get fresh evidence now: run the tests or the build, read the files, look at the process output. Don't rely on what earlier turns said. If every requirement holds, call goal_update with status "complete" again. If anything falls short, say what and keep working on it; the goal goes on.

Objective:
%s
</goal-audit>`, g.Turns+1, g.Reason, g.Objective)
}

func goalContinuation(g *protocol.AgentGoal, note string) string {
	if note != "" {
		note += "\n\n"
	}
	return fmt.Sprintf(`<goal-continuation turn="%d" max-turns="%d">
%sContinue working toward this thread's goal. This message is from Everywhere, not from the user.

Objective:
%s
</goal-continuation>

%s`, g.Turns+1, g.MaxTurns, note, g.Objective, goalRules)
}
