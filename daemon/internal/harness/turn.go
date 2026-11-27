package harness

import (
	"strconv"
	"strings"
	"time"
)

// An agent's turn, as the engine sees it, needn't end with its prompt.
// Antigravity's prompt returns while commands it started run on, and when
// one ends (or a timer it set fires) it wakes and replies, and asks for
// permissions, with no prompt open. For such an agent (Agent.BackgroundWork)
// a turn ends once it's done: no command of its own running and nothing
// from it for a moment. Output with no turn open starts one.

// How long a turn is held for an agent's work after its prompt.
var (
	// SettleQuiet is how long nothing must come from it.
	SettleQuiet = 3 * time.Second
	// ReplyQuiet is the most a reply it began (and didn't end with a
	// usage_update) holds the turn after its last output.
	ReplyQuiet = 2 * time.Minute
	// CommandHold is the most a command it left running holds the turn:
	// it sometimes loses a command's end.
	CommandHold = 30 * time.Minute
	// StopTimeout is how long Stop waits for it to end its prompt.
	StopTimeout = 10 * time.Second
)

type turnState struct {
	// open: the engine's turn is running.
	open bool
	// gen counts prompts; a prompt's answer counts only if it's the latest
	// (a steer supersedes the one before).
	gen int
	// returned is closed when the latest prompt has returned.
	returned chan struct{}
	// stopped: Stop was pressed; what the stopped run sends is dropped
	// until the next prompt.
	stopped bool
	// result ends the turn once the agent's work after its prompt is done.
	result map[string]any
	// replyOpen: it's replying with no prompt open (a reply ends with
	// usage_update).
	replyOpen    bool
	lastActivity time.Time
	settledAt    time.Time
	timer        *time.Timer
}

// nextPromptLocked starts a prompt, superseding any before it.
func (t *turnState) nextPromptLocked() int {
	t.gen++
	t.returned = make(chan struct{})
	t.result = nil
	return t.gen
}

func (t *turnState) promptReturned() {
	if t.returned != nil {
		select {
		case <-t.returned:
		default:
			close(t.returned)
		}
	}
	t.replyOpen = false
	t.lastActivity = time.Now()
}

// steers: the agent takes a prompt sent mid-turn as a steer (Agent.Steers).
func (c *Conn) steers() bool {
	return c.agent.SteersSince != "" && versionAtLeast(c.init.AgentInfo.Version, c.agent.SteersSince)
}

// openTurnLocked notes a turn begun, and tells the engine if it began it.
func (c *Conn) openTurnLocked() {
	if c.turn.open {
		return
	}
	c.turn.open = true
	c.turn.result = nil
	c.turn.lastActivity = time.Now()
	c.emitLocked(message("system", "harness_turn", map[string]any{}))
}

// wakeLocked opens a turn for output that comes with no turn open: the
// agent woke on its own.
func (c *Conn) wakeLocked() {
	if c.turn.open || c.turn.stopped || !c.agent.BackgroundWork {
		return
	}
	c.openTurnLocked()
	c.settleLocked(map[string]any{"subtype": "success", "stop_reason": "end_turn"})
}

// activityLocked notes output from the agent: kind is its update's.
func (c *Conn) activityLocked(kind string) {
	c.turn.lastActivity = time.Now()
	switch kind {
	case "usage_update":
		c.turn.replyOpen = false
	case "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan":
		if !c.prompting {
			c.turn.replyOpen = true
		}
	}
}

// settleLocked holds the turn, to end with result once the agent is done.
func (c *Conn) settleLocked(result map[string]any) {
	c.turn.result = result
	c.turn.settledAt = time.Now()
	c.scheduleLocked(SettleQuiet)
}

func (c *Conn) scheduleLocked(d time.Duration) {
	if c.turn.timer != nil {
		c.turn.timer.Stop()
	}
	c.turn.timer = time.AfterFunc(d, c.checkSettled)
}

// checkSettled ends a held turn once the agent is done with it.
func (c *Conn) checkSettled() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.turn.open || c.prompting || c.turn.result == nil || c.ended {
		return
	}
	now := time.Now()
	quiet := now.Sub(c.turn.lastActivity)
	switch {
	case c.runningCommandsLocked() && now.Sub(c.turn.settledAt) < CommandHold:
		c.scheduleLocked(time.Second)
	case c.turn.replyOpen && quiet < ReplyQuiet:
		c.scheduleLocked(min(ReplyQuiet-quiet, time.Second))
	case quiet < SettleQuiet:
		c.scheduleLocked(SettleQuiet - quiet)
	default:
		c.endTurnLocked(c.turn.result)
	}
}

// runningCommandsLocked: a command it started hasn't ended.
func (c *Conn) runningCommandsLocked() bool {
	for _, t := range c.tools {
		if t.kind == "execute" && t.emitted {
			return true
		}
	}
	return false
}

// endTurnLocked ends the engine's turn with result.
func (c *Conn) endTurnLocked(result map[string]any) {
	if c.turn.timer != nil {
		c.turn.timer.Stop()
		c.turn.timer = nil
	}
	c.turn.open, c.turn.result, c.turn.replyOpen = false, nil, false
	c.flushLocked() // what it said with no prompt open
	c.tools = map[string]*toolCall{}
	c.emitLocked(message("result", "", result))
}

// versionAtLeast compares dotted versions ("1.5.18" >= "1.5.0"); one it
// can't read is taken as older.
func versionAtLeast(v, min string) bool {
	a, b := strings.Split(strings.TrimPrefix(v, "v"), "."), strings.Split(min, ".")
	for i := range max(len(a), len(b)) {
		x, y := 0, 0
		if i < len(a) {
			n, err := strconv.Atoi(strings.SplitN(a[i], "-", 2)[0])
			if err != nil {
				return false
			}
			x = n
		}
		if i < len(b) {
			y, _ = strconv.Atoi(b[i])
		}
		if x != y {
			return x > y
		}
	}
	return true
}
