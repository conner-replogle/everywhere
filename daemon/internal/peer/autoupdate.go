package peer

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/version"
)

// Updating when idle: the daemon looks for a release every hour or so and,
// once nothing a restart would lose is going on, installs it and restarts.
const (
	// autoFirstCheck is how long after starting the first look waits, so a
	// daemon that just restarted (perhaps into a bad release) settles first.
	autoFirstCheck = 10 * time.Minute
	autoCheckEvery = time.Hour
	// autoRetry is how often a found update looks again for a quiet moment.
	autoRetry = 5 * time.Minute
	// quietFor is how long no thread must have been used.
	quietFor = 15 * time.Minute
)

// RunAutoUpdate updates the daemon when it's idle, until ctx ends or it
// restarts into an update. Development builds and daemons that can't
// restart themselves don't.
func (s *Server) RunAutoUpdate(ctx context.Context) {
	if version.Version == "dev" || s.Restart == nil {
		return
	}
	jitter := func(d time.Duration) time.Duration { return d + rand.N(d/4) }
	wait := jitter(autoFirstCheck)
	pending := "" // a release found, waiting for a quiet moment
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = jitter(autoCheckEvery)
		if s.AutoUpdate == nil || !s.AutoUpdate() {
			pending = ""
			continue
		}
		if pending == "" {
			info, err := s.checkUpdate(true)
			if err != nil {
				slog.Warn("auto-update: checking for a release", "err", err)
				continue
			}
			if !info.Available {
				continue
			}
			pending = info.Latest
			slog.Info("auto-update: found a release", "version", pending)
		}
		if holds := s.restartHolds(time.Now()); len(holds) > 0 {
			slog.Info("auto-update: waiting", "version", pending, "for", holds)
			wait = jitter(autoRetry)
			continue
		}
		slog.Info("auto-update: idle, updating", "version", pending)
		if _, err := s.applyUpdate(true); err != nil {
			slog.Warn("auto-update failed", "err", err)
			pending = ""
			continue
		}
		return
	}
}

// restartHolds says what a restart would lose now: claude at work or
// waiting on someone, running processes, someone using a thread lately,
// and what plugins say (a command running in a terminal, the remote
// desktop in use). Empty when the daemon is idle.
func (s *Server) restartHolds(now time.Time) []string {
	var out []string
	threads, err := s.store.ListLiveThreads()
	if err != nil {
		return []string{"its threads couldn't be read: " + err.Error()}
	}
	var working, waiting, processes int
	for i := range threads {
		t := &threads[i]
		s.plugins.Decorate(t)
		switch t.AgentStatus {
		case "working", "starting":
			working++
		case "waiting":
			waiting++
		}
		processes += t.Processes
	}
	if working > 0 {
		out = append(out, plural(working, "an agent is working", "agents are working"))
	}
	if waiting > 0 {
		out = append(out, plural(waiting, "an agent is waiting on you", "agents are waiting on you"))
	}
	if processes > 0 {
		out = append(out, plural(processes, "a process is running", "processes are running"))
	}
	if at, err := s.store.LastActivity(); err == nil && now.Sub(time.UnixMilli(at)) < quietFor {
		out = append(out, fmt.Sprintf("a thread was used in the last %d minutes", int(quietFor.Minutes())))
	}
	return append(out, s.plugins.RestartHolds()...)
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return fmt.Sprintf("%d %s", n, many)
}

const autoUpdatedKey = "autoUpdated"

// recordAutoUpdate keeps the update the daemon is about to make by itself.
func (s *Server) recordAutoUpdate(u protocol.AutoUpdated) {
	b, _ := json.Marshal(u)
	if err := s.store.KVSet("core", "", autoUpdatedKey, b); err != nil {
		slog.Warn("auto-update: recording it", "err", err)
	}
}

// lastAutoUpdate is the last update the daemon made by itself, if any.
func (s *Server) lastAutoUpdate() *protocol.AutoUpdated {
	b, ok, err := s.store.KVGet("core", "", autoUpdatedKey)
	if err != nil || !ok {
		return nil
	}
	var u protocol.AutoUpdated
	if json.Unmarshal(b, &u) != nil {
		return nil
	}
	return &u
}
