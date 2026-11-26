package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/conner-replogle/everywhere/daemon/internal/harness"
)

// The account's API keys for agents other than claude (set in the app's
// Settings, sent by the hub with agent.setKeys), by kind: an agent with a
// key uses it in place of its own sign-in (harness.Agent.Key). They're kept
// in the daemon's data directory, so threads started while the hub is out
// of reach still have them.

// agentKey is the account's key for a kind of agent, or "".
func (m *Manager) agentKey(kind string) string {
	keys, err := m.loadAgentKeys()
	if err != nil {
		slog.Warn("agent keys unreadable; agents use their own sign-in", "err", err)
	}
	return keys[kind]
}

func (m *Manager) loadAgentKeys() (map[string]string, error) {
	m.keysMu.Lock()
	defer m.keysMu.Unlock()
	return m.loadAgentKeysLocked()
}

// loadAgentKeysLocked reads them once; after that they're kept in memory.
func (m *Manager) loadAgentKeysLocked() (map[string]string, error) {
	if m.keys != nil {
		return m.keys, nil
	}
	raw, err := os.ReadFile(m.keysPath)
	if errors.Is(err, os.ErrNotExist) {
		m.keys = map[string]string{}
		return m.keys, nil
	}
	if err != nil {
		return map[string]string{}, err
	}
	keys := map[string]string{}
	if err := json.Unmarshal(raw, &keys); err != nil {
		return map[string]string{}, err
	}
	m.keys = keys
	return keys, nil
}

// SetAgentKeys replaces the account's agent keys with keys (kind -> key; a
// kind left out has none). A key for an agent this daemon knows is checked
// against it; one for an agent it doesn't is kept for when it does. Idle
// threads of a kind whose key changed make way for ones that use the new
// one, as after claude signs in.
func (m *Manager) SetAgentKeys(keys map[string]string) error {
	clean := map[string]string{}
	for kind, key := range keys {
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if a, ok := harness.ByKind(kind); ok {
			if err := a.Key.Valid(key); err != nil {
				return fmt.Errorf("%s: %w", a.Title, err)
			}
		}
		clean[kind] = key
	}

	m.keysMu.Lock()
	old, _ := m.loadAgentKeysLocked()
	if maps.Equal(old, clean) {
		m.keysMu.Unlock()
		return nil
	}
	if err := m.saveAgentKeysLocked(clean); err != nil {
		m.keysMu.Unlock()
		return err
	}
	m.keys = clean
	m.keysMu.Unlock()

	changed := map[string]bool{}
	for kind := range old {
		changed[kind] = old[kind] != clean[kind]
	}
	for kind := range clean {
		changed[kind] = changed[kind] || old[kind] != clean[kind]
	}
	m.mu.Lock()
	var sessions []*session
	for _, s := range m.sessions {
		if s.agent != nil && changed[s.agent.Kind] {
			sessions = append(sessions, s)
		}
	}
	m.mu.Unlock()
	for kind, c := range changed {
		if c {
			slog.Info("agent key changed", "kind", kind, "set", clean[kind] != "")
		}
	}
	for _, s := range sessions {
		s.do(s.changed)
	}
	// What a kind offers may only now be learnable, with a key to start it.
	for _, kind := range slices.Sorted(maps.Keys(changed)) {
		if a, ok := harness.ByKind(kind); ok && changed[kind] && clean[kind] != "" {
			go m.probeAgent(a)
		}
	}
	return nil
}

func (m *Manager) saveAgentKeysLocked(keys map[string]string) error {
	if len(keys) == 0 {
		if err := os.Remove(m.keysPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	raw, _ := json.Marshal(keys)
	if err := os.MkdirAll(filepath.Dir(m.keysPath), 0o700); err != nil {
		return err
	}
	tmp := m.keysPath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, m.keysPath)
}
