package peer

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/update"
	"github.com/conner-replogle/everywhere/daemon/internal/version"
)

// How long a latest-release lookup is reused, so that several open tabs
// re-checking on focus don't each hit GitHub.
const updateCheckTTL = 2 * time.Minute

// checkUpdate compares this daemon with the latest release. force skips the
// cached lookup.
func (s *Server) checkUpdate(force bool) (protocol.UpdateInfo, error) {
	info := protocol.UpdateInfo{Current: version.Version}
	switch {
	case version.Version == "dev":
		info.Reason = "This is a development build."
	case s.Restart == nil:
		info.Reason = "This daemon can't restart itself."
	}

	s.updateMu.Lock()
	latest, fresh := s.latest, !force && time.Since(s.latestAt) < updateCheckTTL
	s.updateMu.Unlock()
	if !fresh {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		v, err := update.LatestVersion(ctx)
		if err != nil {
			return info, err
		}
		latest = v
		s.updateMu.Lock()
		s.latest, s.latestAt = v, time.Now()
		s.updateMu.Unlock()
	}
	info.Latest = latest
	info.Available = info.Reason == "" && update.Newer(latest, version.Version)
	return info, nil
}

// applyUpdate installs the latest release over the running binary, then
// restarts into it once the response has gone out.
func (s *Server) applyUpdate() (protocol.UpdateResult, error) {
	if !s.updating.CompareAndSwap(false, true) {
		return protocol.UpdateResult{}, errors.New("an update is already in progress")
	}
	restarting := false
	defer func() {
		if !restarting {
			s.updating.Store(false)
		}
	}()

	info, err := s.checkUpdate(true)
	if err != nil {
		return protocol.UpdateResult{}, err
	}
	if !info.Available {
		if info.Reason != "" {
			return protocol.UpdateResult{}, errors.New(info.Reason)
		}
		return protocol.UpdateResult{}, fmt.Errorf("already up to date (%s)", info.Current)
	}
	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.EvalSymlinks(exe)
	}
	if err != nil {
		return protocol.UpdateResult{}, err
	}
	slog.Info("updating", "from", info.Current, "to", info.Latest, "binary", exe)
	if err := update.Latest(exe); err != nil {
		return protocol.UpdateResult{}, fmt.Errorf("installing %s: %w", info.Latest, err)
	}
	restarting = true
	s.agents.MarkForContinuation()
	go func() {
		time.Sleep(500 * time.Millisecond)
		slog.Info("restarting into new version", "version", info.Latest)
		s.Restart()
	}()
	return protocol.UpdateResult{Version: info.Latest}, nil
}
