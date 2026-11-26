package agent

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/claude"
	"github.com/conner-replogle/everywhere/daemon/internal/harness"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// agentConfig is what an agent other than claude offers every thread: its
// models and modes, and which it starts with (its defaults). A thread learns them when its
// agent starts; the manager keeps the last seen per kind (and on disk), so
// a thread that hasn't started yet can offer them too.
type agentConfig struct {
	Models []protocol.AgentModel `json:"models"`
	Modes  []protocol.AgentMode  `json:"modes"`
	Model  string                `json:"model,omitempty"`
	Mode   string                `json:"mode,omitempty"`
}

const probeTimeout = time.Minute

func (m *Manager) agentConfigPath(kind string) string {
	return filepath.Join(m.agentDir, "config", kind+".json")
}

// agentConfigFor is the kind's config as last seen, if it's known.
func (m *Manager) agentConfigFor(kind string) (agentConfig, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.agentConfigLocked(kind)
}

// agentConfigLocked is agentConfigFor with m.mu held.
func (m *Manager) agentConfigLocked(kind string) (agentConfig, bool) {
	if c, ok := m.agentConfigs[kind]; ok {
		return c, true
	}
	var c agentConfig
	b, err := os.ReadFile(m.agentConfigPath(kind))
	if err != nil || json.Unmarshal(b, &c) != nil || len(c.Models)+len(c.Modes) == 0 {
		return agentConfig{}, false
	}
	m.agentConfigs[kind] = c
	return c, true
}

// noteAgentConfig keeps what an agent reported, and gives it to the kind's
// threads that don't know it yet.
func (m *Manager) noteAgentConfig(kind string, c agentConfig) {
	if len(c.Models)+len(c.Modes) == 0 {
		return
	}
	m.mu.Lock()
	m.agentConfigs[kind] = c
	var waiting []*session
	for _, s := range m.sessions {
		if s.agent != nil && s.agent.Kind == kind {
			waiting = append(waiting, s)
		}
	}
	m.mu.Unlock()
	if b, err := json.Marshal(c); err == nil {
		path := m.agentConfigPath(kind)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err == nil {
			err = os.WriteFile(path, b, 0o600)
		}
		if err != nil {
			slog.Warn("saving agent config", "kind", kind, "err", err)
		}
	}
	for _, s := range waiting {
		s.do(func() {
			if s.proc == nil && s.applyAgentConfig(c) {
				s.changed()
			}
		})
	}
}

// probeAgent learns a kind's config when nothing's known of it, by starting
// the agent in a folder of its own (once at a time per kind) and stopping it
// once it has reported, before any prompt.
func (m *Manager) probeAgent(a harness.Agent) {
	if _, ok := m.agentConfigFor(a.Kind); ok {
		return
	}
	m.mu.Lock()
	if m.probing[a.Kind] {
		m.mu.Unlock()
		return
	}
	m.probing[a.Kind] = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.probing, a.Kind)
		m.mu.Unlock()
	}()

	dir := filepath.Join(m.agentDir, "probe", a.Kind)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		slog.Warn("probing agent", "kind", a.Kind, "err", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	p, err := m.startAgent(ctx, harness.StartOptions{Agent: a, Dir: dir})
	if err != nil {
		slog.Warn("probing agent", "kind", a.Kind, "err", err)
		return
	}
	defer p.Close()
	for {
		select {
		case msg, ok := <-p.Messages():
			if !ok {
				return
			}
			if msg.Type == "system" && msg.Subtype == "harness_config" {
				if c, ok := decodeAgentConfig(msg); ok {
					m.noteAgentConfig(a.Kind, c)
				}
				return
			}
		case <-ctx.Done():
			slog.Warn("probing agent: no config reported", "kind", a.Kind)
			return
		}
	}
}

// decodeAgentConfig reads a harness_config message.
func decodeAgentConfig(msg claude.Message) (agentConfig, bool) {
	type option struct{ Value, Label, Description string }
	var f struct {
		Models *[]option `json:"models"`
		Modes  *[]option `json:"modes"`
		Model  string    `json:"model"`
		Mode   string    `json:"mode"`
	}
	if msg.Decode(&f) != nil {
		return agentConfig{}, false
	}
	var c agentConfig
	if f.Models != nil {
		c.Models = make([]protocol.AgentModel, 0, len(*f.Models))
		for _, o := range *f.Models {
			c.Models = append(c.Models, protocol.AgentModel{Value: o.Value, DisplayName: o.Label, Description: o.Description})
		}
	}
	if f.Modes != nil {
		c.Modes = make([]protocol.AgentMode, 0, len(*f.Modes))
		for _, o := range *f.Modes {
			c.Modes = append(c.Modes, protocol.AgentMode{Value: o.Value, Label: o.Label, Description: o.Description})
		}
	}
	c.Model, c.Mode = f.Model, f.Mode
	return c, f.Models != nil || f.Modes != nil
}

// applyAgentConfig shows a known config in a thread whose agent hasn't
// reported its own; it reports whether the state changed.
func (s *session) applyAgentConfig(c agentConfig) bool {
	changed := false
	if len(s.state.Models) == 0 && len(c.Models) > 0 {
		s.state.Models, changed = c.Models, true
	}
	if len(s.state.Modes) == 0 && len(c.Modes) > 0 {
		s.state.Modes, changed = c.Modes, true
	}
	// Its defaults are shown, not saved, until others are chosen.
	if s.state.Model == "" && c.Model != "" {
		s.state.Model, changed = c.Model, true
	}
	if s.state.PermissionMode == "" && c.Mode != "" {
		s.state.PermissionMode, changed = c.Mode, true
	}
	return changed
}
