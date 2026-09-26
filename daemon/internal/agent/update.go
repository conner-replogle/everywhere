package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"os/exec"
	"slices"
	"strings"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/claude"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/update"
)

// Claude Code updates: noticing a new build (however it was installed) and
// moving threads over to it, and updating it from here.

const (
	// How long the newest Claude Code release is reused.
	latestTTL = time.Hour
	// How long an update may run: a download on a slow link.
	claudeUpdateTimeout = 5 * time.Minute
	// How much of a failed update's output its error carries.
	maxUpdateOutput = 2000
)

// noteBuild records which claude build bin is and its version. It reports
// whether that's a new build since one was last seen.
func (m *Manager) noteBuild(ctx context.Context, bin string, env []string) bool {
	b, err := claude.Build(bin, env)
	if err != nil {
		return false
	}
	m.mu.Lock()
	prev := m.build
	m.mu.Unlock()
	if b == prev {
		return false
	}
	v, err := claude.Version(ctx, bin)
	if err != nil {
		slog.Warn("reading claude's version", "bin", bin, "err", err)
	}
	m.mu.Lock()
	m.build, m.version = b, v
	m.mu.Unlock()
	return prev != ""
}

// currentBuild is the claude build a new process starts, and its version.
func (m *Manager) currentBuild() (build, version string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.build, m.version
}

// checkClaude looks, as a thread is opened, for claude having been updated
// since it last started.
func (m *Manager) checkClaude() {
	if !m.checking.CompareAndSwap(false, true) {
		return
	}
	defer m.checking.Store(false)
	m.launchMu.Lock()
	bin, env := m.bin, m.env
	m.launchMu.Unlock()
	if bin == "" {
		return // claude hasn't started yet; its first start records the build
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if m.noteBuild(ctx, bin, env) {
		m.claudeChanged()
	}
}

// claudeChanged runs once claude has been updated. It learns the new build's
// models, shows them in every open thread, and moves each thread's claude
// over to it when the thread is next idle (see session.changed).
func (m *Manager) claudeChanged() {
	_, v := m.currentBuild()
	slog.Info("claude was updated", "version", v)
	m.mu.Lock()
	m.infoAt = time.Time{}
	m.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	m.Info(ctx)
	m.mu.Lock()
	sessions := slices.Collect(maps.Values(m.sessions))
	m.mu.Unlock()
	for _, s := range sessions {
		s.do(s.changed)
	}
}

// ClaudeVersion reports the device's Claude Code against the newest release.
// force skips the cached lookup of the release.
func (m *Manager) ClaudeVersion(ctx context.Context, force bool) (protocol.ClaudeVersion, error) {
	bin, env, err := m.claudeBinary(ctx)
	if err != nil {
		return protocol.ClaudeVersion{}, err
	}
	if m.noteBuild(ctx, bin, env) {
		go m.claudeChanged()
	}
	latest, err := m.latestClaude(ctx, force)
	if err != nil {
		return protocol.ClaudeVersion{}, err
	}
	_, current := m.currentBuild()
	cmd := claude.UpdateCommand(bin, env)
	return protocol.ClaudeVersion{
		Current:   current,
		Latest:    latest,
		Available: update.Newer(latest, current),
		Path:      bin,
		CanUpdate: cmd != nil,
		Command:   strings.Join(cmd, " "),
	}, nil
}

func (m *Manager) latestClaude(ctx context.Context, force bool) (string, error) {
	m.mu.Lock()
	latest, fresh := m.latest, !force && time.Since(m.latestAt) < latestTTL
	m.mu.Unlock()
	if fresh {
		return latest, nil
	}
	latest, err := claude.LatestVersion(ctx)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	m.latest, m.latestAt = latest, time.Now()
	m.mu.Unlock()
	return latest, nil
}

// UpdateClaude updates Claude Code with the installer that owns it, then
// moves open threads over to the new version.
func (m *Manager) UpdateClaude(ctx context.Context) (protocol.ClaudeUpdateResult, error) {
	if !m.updating.CompareAndSwap(false, true) {
		return protocol.ClaudeUpdateResult{}, errors.New("Claude Code is already updating")
	}
	defer m.updating.Store(false)
	bin, env, err := m.claudeBinary(ctx)
	if err != nil {
		return protocol.ClaudeUpdateResult{}, err
	}
	// Judged again now, not from the last check.
	args := claude.UpdateCommand(bin, env)
	if args == nil {
		return protocol.ClaudeUpdateResult{}, errors.New("can't tell how Claude Code was installed here, so update it the way you installed it")
	}
	ctx, cancel := context.WithTimeout(ctx, claudeUpdateTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Env = env
	cmd.Dir, _ = os.UserHomeDir()
	if out, err := cmd.CombinedOutput(); err != nil {
		text := strings.TrimSpace(string(out))
		if len(text) > maxUpdateOutput {
			text = "…" + text[len(text)-maxUpdateOutput:]
		}
		return protocol.ClaudeUpdateResult{}, fmt.Errorf("%s: %w\n%s", strings.Join(args, " "), err, text)
	}
	// Before answering, so the models are the new build's by then.
	if m.noteBuild(ctx, bin, env) {
		m.claudeChanged()
	}
	_, v := m.currentBuild()
	return protocol.ClaudeUpdateResult{Version: v}, nil
}
