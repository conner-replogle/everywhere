package agent

import (
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// The account's custom instructions: text the user writes in Settings that
// every claude thread on every device gets in its system prompt. The hub
// sends them (agent.setInstructions) as the daemon connects and when they
// change; kept on disk so threads started before the hub answers have them.

// maxInstructions bounds them (the Worker allows less).
const maxInstructions = 32 << 10

// instructionsHeader says where they come from, so claude weighs them as the user's.
const instructionsHeader = "The user's own instructions for every thread (from their Everywhere settings):\n\n"

func (p *Plugin) instructionsPath() string { return filepath.Join(p.h.DataDir(), "instructions.md") }

// instructions are the account's custom instructions, or "" for none.
func (p *Plugin) instructions() string {
	b, err := os.ReadFile(p.instructionsPath())
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			slog.Warn("custom instructions unreadable", "err", err)
		}
		return ""
	}
	return strings.TrimSpace(string(b))
}

// setInstructions keeps them for the next claude started ("" removes them).
// Running claudes keep the ones they started with.
func (p *Plugin) setInstructions(s string) error {
	s = strings.TrimSpace(s)
	if len(s) > maxInstructions {
		return errors.New("custom instructions are too long")
	}
	if s == p.instructions() {
		return nil
	}
	path := p.instructionsPath()
	if s == "" {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		slog.Info("custom instructions removed")
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(s), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	slog.Info("custom instructions set", "bytes", len(s))
	return nil
}
