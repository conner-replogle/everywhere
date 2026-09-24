package agent

import (
	"encoding/json"
	"slices"
	"sort"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/claude"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// What claude reports that is the same for every thread on the device:
// models, account, slash commands and plan usage. Kept on the Manager so a
// thread that hasn't started yet can show it.

// noteInit remembers the models, account and commands from a claude
// initialize.
func (m *Manager) noteInit(init claude.InitResponse) {
	models := make([]protocol.AgentModel, 0, len(init.Models))
	for _, mo := range init.Models {
		am := protocol.AgentModel{
			Value:       mo.Value,
			DisplayName: mo.DisplayName,
			Description: mo.Description,
			Thinking:    mo.SupportsAdaptiveThinking,
		}
		if mo.SupportsEffort {
			am.EffortLevels = mo.SupportedEffortLevels
		}
		models = append(models, am)
	}
	var account *protocol.AgentAccount
	if a := init.Account; a.Email != "" || a.SubscriptionType != "" {
		account = &protocol.AgentAccount{Email: a.Email, SubscriptionType: a.SubscriptionType}
	}
	m.mu.Lock()
	m.models, m.account, m.infoAt = models, account, time.Now()
	m.mu.Unlock()
	m.setCommands(init.Commands)
}

// setCommands replaces the slash command list (from initialize or a
// commands_changed message).
func (m *Manager) setCommands(cmds []claude.SlashCommand) {
	out := make([]protocol.AgentCommand, 0, len(cmds))
	for _, c := range cmds {
		out = append(out, protocol.AgentCommand{Name: c.Name, Description: c.Description, ArgumentHint: c.ArgumentHint})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	m.mu.Lock()
	m.commands = out
	m.mu.Unlock()
}

// noteTerminalCommands records the commands claude says only make sense in
// its own terminal UI (e.g. exit, statusline); they're hidden here.
func (m *Manager) noteTerminalCommands(names []string) {
	if len(names) == 0 {
		return
	}
	m.mu.Lock()
	m.terminalOnly = names
	m.mu.Unlock()
}

func (m *Manager) visibleCommands() []protocol.AgentCommand {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]protocol.AgentCommand, 0, len(m.commands))
	for _, c := range m.commands {
		if !slices.Contains(m.terminalOnly, c.Name) {
			out = append(out, c)
		}
	}
	return out
}

func (m *Manager) setLimits(limits []protocol.AgentLimit) {
	if len(limits) == 0 {
		return
	}
	sort.Slice(limits, func(i, j int) bool { return windowOrder(limits[i].Window) < windowOrder(limits[j].Window) })
	m.mu.Lock()
	m.limits = limits
	m.mu.Unlock()
}

func (m *Manager) currentLimits() []protocol.AgentLimit {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.limits
}

func windowOrder(w string) int {
	switch w {
	case "five_hour":
		return 0
	case "seven_day":
		return 1
	}
	return 2
}

// limitsFromEvent reads a rate_limit_event's windows: utilization is a
// fraction, resetsAt unix seconds.
func limitsFromEvent(info json.RawMessage) []protocol.AgentLimit {
	var f struct {
		Windows map[string]struct {
			Utilization *float64 `json:"utilization"`
			ResetsAt    int64    `json:"resetsAt"`
		} `json:"unifiedWindows"`
	}
	if json.Unmarshal(info, &f) != nil {
		return nil
	}
	var out []protocol.AgentLimit
	for name, w := range f.Windows {
		if w.Utilization == nil {
			continue
		}
		out = append(out, protocol.AgentLimit{Window: name, Used: fraction(*w.Utilization), ResetsAt: w.ResetsAt * 1000})
	}
	return out
}

// limitsFromUsage reads get_usage's windows. Its utilization scale isn't
// documented, so values above 1 are taken as percentages.
func limitsFromUsage(u claude.Usage) []protocol.AgentLimit {
	if !u.RateLimitsAvailable {
		return nil
	}
	var out []protocol.AgentLimit
	for name, w := range u.RateLimits {
		if w == nil || w.Utilization == nil {
			continue
		}
		l := protocol.AgentLimit{Window: name, Used: fraction(*w.Utilization)}
		if w.ResetsAt != nil {
			if t, err := time.Parse(time.RFC3339, *w.ResetsAt); err == nil {
				l.ResetsAt = t.UnixMilli()
			}
		}
		out = append(out, l)
	}
	return out
}

func fraction(v float64) float64 {
	if v > 1 {
		v /= 100
	}
	return min(max(v, 0), 1)
}
