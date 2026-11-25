package agent

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/claude"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

const (
	toolTurn = `{"type":"assistant","uuid":"a1","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"make"}}]}}`
	talkTurn = `{"type":"assistant","uuid":"a2","message":{"id":"m2","content":[{"type":"text","text":"Working on it."}]}}`
	turnOK   = `{"type":"result","subtype":"success"}`
)

func newGoalHarness(t *testing.T) *rig {
	h := newHarness(t)
	h.m.GoalDelay = time.Millisecond
	return h
}

// lastText is the text of the last message sent to p.
func lastText(p *fakeProc) string {
	sent := p.sentMessages()
	if len(sent) == 0 {
		return ""
	}
	c := sent[len(sent)-1].Content
	return c[len(c)-1].Text
}

func waitSent(t *testing.T, p *fakeProc, n int) {
	t.Helper()
	eventually(t, "message "+string(rune('0'+n))+" sent", func() bool { return len(p.sentMessages()) >= n })
}

func (h *rig) goal() *protocol.AgentGoal {
	h.t.Helper()
	g, err := h.m.Goal(h.thread)
	if err != nil {
		h.t.Fatal(err)
	}
	return g
}

func (h *rig) waitGoal(status string) {
	h.t.Helper()
	eventually(h.t, "goal "+status, func() bool { g := h.goal(); return g != nil && g.Status == status })
}

// workTurn ends the current turn after a tool call.
func workTurn(p *fakeProc) {
	p.emit(toolTurn)
	p.emit(turnOK)
}

// stays checks that nothing more is sent to p for a while.
func stays(t *testing.T, p *fakeProc, n int) {
	t.Helper()
	time.Sleep(50 * time.Millisecond)
	if got := len(p.sentMessages()); got != n {
		t.Fatalf("%d messages sent, want %d: %q", got, n, lastText(p))
	}
}

func TestGoalContinuesUntilComplete(t *testing.T) {
	h := newGoalHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "/goal make the tests pass"})
	p := h.proc(0)
	waitSent(t, p, 1)
	if got := lastText(p); !strings.Contains(got, "<goal>") || !strings.Contains(got, "make the tests pass") {
		t.Fatalf("kickoff %q", got)
	}
	if g := h.goal(); g.Status != protocol.GoalActive || g.Turns != 1 || g.MaxTurns != DefaultGoalMaxTurns {
		t.Fatalf("goal %+v", g)
	}

	// A turn that did something is followed by another.
	workTurn(p)
	waitSent(t, p, 2)
	if got := lastText(p); !strings.Contains(got, `<goal-continuation turn="2"`) {
		t.Fatalf("continuation %q", got)
	}

	// The agent says it's complete: the next turn checks the claim.
	p.emit(toolTurn)
	if _, err := h.m.UpdateGoal(h.thread, protocol.GoalComplete, "all 12 tests pass", false); err != nil {
		t.Fatal(err)
	}
	p.emit(turnOK)
	waitSent(t, p, 3)
	if got := lastText(p); !strings.Contains(got, "<goal-audit") || !strings.Contains(got, "all 12 tests pass") {
		t.Fatalf("audit %q", got)
	}
	if g := h.goal(); g.Status != protocol.GoalActive || g.Audit != "running" {
		t.Fatalf("goal during the audit %+v", g)
	}
	if th, _ := h.st.GetThread(h.thread); th.DoneAt != nil {
		t.Fatal("done before the audit")
	}

	// A claim in the audit completes it, and the thread is done.
	p.emit(toolTurn)
	reply, err := h.m.UpdateGoal(h.thread, protocol.GoalComplete, "all 12 tests pass", false)
	if err != nil || !strings.Contains(reply, "complete") {
		t.Fatalf("UpdateGoal = %q, %v", reply, err)
	}
	p.emit(turnOK)
	h.waitStatus(c, "idle")
	stays(t, p, 3)
	if g := h.goal(); g.Status != protocol.GoalComplete || g.Reason != "all 12 tests pass" {
		t.Fatalf("goal %+v", g)
	}
	eventually(t, "thread done", func() bool { th, _ := h.st.GetThread(h.thread); return th.DoneAt != nil })
	if g := c.state().Goal; g == nil || g.Status != protocol.GoalComplete {
		t.Fatalf("state's goal %+v", g)
	}
}

func TestGoalPausesWithoutProgress(t *testing.T) {
	h := newGoalHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "goal", Action: "set", Text: "ship it"})
	p := h.proc(0)
	for i := 1; i <= goalStallLimit; i++ {
		waitSent(t, p, i)
		p.emit(talkTurn)
		p.emit(turnOK)
	}
	h.waitGoal(protocol.GoalPaused)
	stays(t, p, goalStallLimit)
	if g := h.goal(); !strings.Contains(g.Reason, "No progress") {
		t.Fatalf("reason %q", g.Reason)
	}
}

func TestGoalTurnLimitAndResume(t *testing.T) {
	h := newGoalHarness(t)
	h.m.GoalMaxTurns = 2
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "goal", Action: "set", Text: "ship it"})
	p := h.proc(0)
	waitSent(t, p, 1)
	workTurn(p)
	waitSent(t, p, 2)
	workTurn(p)
	h.waitGoal(protocol.GoalLimited)
	stays(t, p, 2)

	// Resuming gives it as many turns again.
	h.do(c, protocol.AgentClientMsg{T: "goal", Action: "resume"})
	waitSent(t, p, 3)
	if g := h.goal(); g.Status != protocol.GoalActive || g.MaxTurns != 4 || g.Turns != 3 {
		t.Fatalf("resumed goal %+v", g)
	}
}

func TestGoalPausedByInterruptAndUser(t *testing.T) {
	h := newGoalHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "/goal ship it"})
	p := h.proc(0)
	waitSent(t, p, 1)
	h.do(c, protocol.AgentClientMsg{T: "interrupt"})
	h.waitGoal(protocol.GoalPaused)
	stays(t, p, 1)

	h.do(c, protocol.AgentClientMsg{T: "send", Text: "/goal resume"})
	waitSent(t, p, 2)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "/goal pause"})
	h.waitGoal(protocol.GoalPaused)
	workTurn(p) // the turn in progress finishes; no other starts
	h.waitStatus(c, "idle")
	stays(t, p, 2)

	h.do(c, protocol.AgentClientMsg{T: "send", Text: "/goal clear"})
	eventually(t, "goal cleared", func() bool { return h.goal() == nil })
	if a, _ := h.st.AgentThread(h.thread); a.Goal != nil {
		t.Fatalf("cleared goal still stored: %s", a.Goal)
	}
}

func TestGoalWaitsForProcess(t *testing.T) {
	h := newGoalHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "/goal train the model"})
	p := h.proc(0)
	waitSent(t, p, 1)
	p.emit(toolTurn)
	if _, err := h.m.UpdateGoal(h.thread, protocol.GoalWaiting, "training run", true); err != nil {
		t.Fatal(err)
	}
	p.emit(turnOK)
	h.waitStatus(c, "idle")
	stays(t, p, 1)
	if g := h.goal(); g.Status != protocol.GoalWaiting {
		t.Fatalf("goal %+v", g)
	}

	// The process's event wakes it, and the goal goes on after that turn.
	h.m.ProcessEvent(h.thread, "train", "Exited 0", "<process-event>done</process-event>", true)
	waitSent(t, p, 2)
	h.waitGoal(protocol.GoalActive)
	workTurn(p)
	waitSent(t, p, 3)
	if got := lastText(p); !strings.Contains(got, "<goal-continuation") {
		t.Fatalf("after the wake %q", got)
	}
}

func TestGoalWaitTimesOut(t *testing.T) {
	h := newGoalHarness(t)
	h.m.GoalWaitTimeout = 20 * time.Millisecond
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "/goal train the model"})
	p := h.proc(0)
	waitSent(t, p, 1)
	p.emit(toolTurn)
	if _, err := h.m.UpdateGoal(h.thread, protocol.GoalWaiting, "training run", true); err != nil {
		t.Fatal(err)
	}
	p.emit(turnOK)
	waitSent(t, p, 2)
	if got := lastText(p); !strings.Contains(got, "nothing woke you") {
		t.Fatalf("after the wait %q", got)
	}
}

func TestGoalUpdateNeedsActiveGoal(t *testing.T) {
	h := newGoalHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "hi"})
	h.proc(0)
	if _, err := h.m.UpdateGoal(h.thread, protocol.GoalComplete, "x", false); err == nil {
		t.Fatal("goal_update without a goal worked")
	}
	h.do(c, protocol.AgentClientMsg{T: "goal", Action: "set", Text: "x"}) // joins the turn
	if _, err := h.m.UpdateGoal(h.thread, "paused", "x", false); err == nil {
		t.Fatal("the agent paused its own goal")
	}
	if _, err := h.m.UpdateGoal(h.thread, protocol.GoalBlocked, "", false); err == nil {
		t.Fatal("blocked without saying what's needed")
	}
}

func TestGoalContinuesAfterRestart(t *testing.T) {
	h := newGoalHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "/goal ship it"})
	p := h.proc(0)
	waitSent(t, p, 1)
	workTurn(p)
	waitSent(t, p, 2)
	h.m.Shutdown()

	h.m = NewManager(h.st, t.TempDir(), func() {})
	h.m.start = func(_ context.Context, o claude.Options) (process, error) {
		np := &fakeProc{opts: o, msgs: make(chan claude.Message, 100)}
		h.mu.Lock()
		h.procs = append(h.procs, np)
		h.mu.Unlock()
		return np, nil
	}
	t.Cleanup(h.m.Shutdown)
	h.m.ContinueMarked()
	p2 := h.proc(1)
	waitSent(t, p2, 1)
	if got := lastText(p2); !strings.Contains(got, "restarted") || !strings.Contains(got, `turn="3"`) {
		t.Fatalf("after restart %q", got)
	}
}

func TestGoalSlashCommandParsing(t *testing.T) {
	h := newGoalHarness(t)
	c := h.attach(0)
	// /goals isn't /goal: it goes to the agent as a prompt.
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "/goals"})
	p := h.proc(0)
	waitSent(t, p, 1)
	if lastText(p) != "/goals" || h.goal() != nil {
		t.Fatalf("sent %q, goal %+v", lastText(p), h.goal())
	}
	p.emit(turnOK)
	h.waitStatus(c, "idle")
	// /goal alone describes it, without a turn.
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "/goal"})
	eventually(t, "goal described", func() bool {
		evs := c.events()
		return len(evs) > 0 && strings.HasPrefix(evs[len(evs)-1].Text, "No goal")
	})
	stays(t, p, 1)
}

func TestGoalAuditThatFindsGapsGoesOn(t *testing.T) {
	h := newGoalHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "/goal ship it"})
	p := h.proc(0)
	waitSent(t, p, 1)
	p.emit(toolTurn)
	if _, err := h.m.UpdateGoal(h.thread, protocol.GoalComplete, "shipped", false); err != nil {
		t.Fatal(err)
	}
	// A second claim in the same turn is still only a claim.
	if _, err := h.m.UpdateGoal(h.thread, protocol.GoalComplete, "shipped", false); err != nil {
		t.Fatal(err)
	}
	p.emit(turnOK)
	waitSent(t, p, 2) // the audit
	workTurn(p)       // finds a gap, works on it, doesn't confirm
	waitSent(t, p, 3)
	if got := lastText(p); !strings.Contains(got, "<goal-continuation") {
		t.Fatalf("after the audit %q", got)
	}
	if g := h.goal(); g.Audit != "" || g.Status != protocol.GoalActive {
		t.Fatalf("goal %+v", g)
	}
}

func TestThreadDoneDefersToGoal(t *testing.T) {
	h := newGoalHarness(t)
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "/goal ship it"})
	waitSent(t, h.proc(0), 1)
	if _, err := h.m.MarkDone(h.thread); err == nil || !strings.Contains(err.Error(), "goal_update") {
		t.Fatalf("thread_done with a goal running: %v", err)
	}
}

func TestGoalWaitNeedsSomethingToWaitOn(t *testing.T) {
	h := newGoalHarness(t)
	h.m.wakeMin = time.Millisecond
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "/goal ship it"})
	waitSent(t, h.proc(0), 1)
	if _, err := h.m.UpdateGoal(h.thread, protocol.GoalWaiting, "deploy", false); err == nil {
		t.Fatal("waited with nothing to wake it")
	}
	if _, err := h.m.ScheduleWake(h.thread, time.Hour, "check the deploy"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.m.UpdateGoal(h.thread, protocol.GoalWaiting, "deploy", false); err != nil {
		t.Fatalf("waiting on a wake: %v", err)
	}
}

func TestWake(t *testing.T) {
	h := newGoalHarness(t)
	h.m.wakeMin = time.Millisecond
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "deploy it"})
	p := h.proc(0)
	waitSent(t, p, 1)
	if _, err := h.m.ScheduleWake(h.thread, time.Millisecond, ""); err == nil {
		t.Fatal("a wake without a reason")
	}
	if _, err := h.m.ScheduleWake(h.thread, 8*24*time.Hour, "later"); err == nil {
		t.Fatal("a wake too far ahead")
	}
	if _, err := h.m.ScheduleWake(h.thread, 30*time.Millisecond, "check the deploy"); err != nil {
		t.Fatal(err)
	}
	if w := c.state(); w.Wake == nil {
		eventually(t, "wake in the state", func() bool { return c.state().Wake != nil })
	}
	p.emit(turnOK)
	h.waitStatus(c, "idle")

	// When it's time, a turn starts with the reason.
	waitSent(t, p, 2)
	if got := lastText(p); !strings.Contains(got, "<scheduled-wake>") || !strings.Contains(got, "check the deploy") {
		t.Fatalf("wake %q", got)
	}
	h.waitStatus(c, "working")
	eventually(t, "wake cleared", func() bool { return c.state().Wake == nil })
	if a, _ := h.st.AgentThread(h.thread); a.Wake != nil {
		t.Fatalf("fired wake still stored: %s", a.Wake)
	}

	// Canceled, it doesn't fire.
	p.emit(turnOK)
	h.waitStatus(c, "idle")
	if _, err := h.m.ScheduleWake(h.thread, 30*time.Millisecond, "again"); err != nil {
		t.Fatal(err)
	}
	h.do(c, protocol.AgentClientMsg{T: "cancelWake"})
	stays(t, p, 2)
}

func TestWakeSurvivesRestart(t *testing.T) {
	h := newGoalHarness(t)
	h.m.wakeMin = time.Millisecond
	c := h.attach(0)
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "hi"})
	p := h.proc(0)
	waitSent(t, p, 1)
	p.emit(turnOK)
	h.waitStatus(c, "idle")
	if _, err := h.m.ScheduleWake(h.thread, 200*time.Millisecond, "check the deploy"); err != nil {
		t.Fatal(err)
	}
	h.m.Shutdown()

	h.m = NewManager(h.st, t.TempDir(), func() {})
	h.m.start = func(_ context.Context, o claude.Options) (process, error) {
		np := &fakeProc{opts: o, msgs: make(chan claude.Message, 100)}
		h.mu.Lock()
		h.procs = append(h.procs, np)
		h.mu.Unlock()
		return np, nil
	}
	t.Cleanup(h.m.Shutdown)
	h.m.ContinueMarked()
	p2 := h.proc(1)
	waitSent(t, p2, 1)
	if got := lastText(p2); !strings.Contains(got, "check the deploy") {
		t.Fatalf("after restart %q", got)
	}
}

func TestThreadGoalStatus(t *testing.T) {
	h := newGoalHarness(t)
	c := h.attach(0)
	if s := h.m.GoalStatus(h.thread); s != "" {
		t.Fatalf("goal status %q", s)
	}
	h.do(c, protocol.AgentClientMsg{T: "send", Text: "/goal ship it"})
	eventually(t, "thread's goal status", func() bool { return h.m.GoalStatus(h.thread) == protocol.GoalActive })
}
