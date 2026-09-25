package desktop

import (
	"bufio"
	"context"
	"log/slog"
	"os/exec"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/wire"
)

// Clipboard text goes both ways while the viewer has clipboard sync on, via
// wl-clipboard (wl-paste --watch / wl-copy, which use the data-control
// protocol). It lives in the session rather than the capture worker, so it
// survives capture restarts.

const textType = "text/plain;charset=utf-8"

// watchClipboard sends the host's clipboard text to the viewer whenever it
// changes (not on connect: that would overwrite the viewer's own clipboard).
func (s *session) watchClipboard() {
	if _, err := exec.LookPath("wl-paste"); err != nil {
		slog.Info("clipboard sync unavailable: wl-clipboard is not installed")
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-s.done
		cancel()
	}()
	for first := true; ; first = false {
		if !first {
			select {
			case <-s.done:
				return
			case <-time.After(2 * time.Second): // wl-paste died, e.g. the compositor restarted
			}
		}
		// `echo` prints a line per change; the text is read separately.
		cmd := exec.CommandContext(ctx, "wl-paste", "--watch", "echo")
		cmd.Env = s.hypr.env()
		out, err := cmd.StdoutPipe()
		if err != nil || cmd.Start() != nil {
			slog.Warn("clipboard watch failed to start", "session", s.id, "err", err)
			continue
		}
		sc := bufio.NewScanner(out)
		initial := true
		for sc.Scan() {
			text, ok := s.readClipboard(ctx)
			s.mu.Lock()
			send := ok && !initial && s.clipSync && text != s.clipLast
			if ok {
				s.clipLast = text
			}
			dc := s.control
			s.mu.Unlock()
			initial = false
			if send && dc != nil {
				_ = dc.Send(wire.MarshalHostClipboard(text))
			}
		}
		_ = cmd.Wait()
	}
}

func (s *session) readClipboard(ctx context.Context) (string, bool) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "wl-paste", "--no-newline", "--type", "text")
	cmd.Env = s.hypr.env()
	out, err := cmd.Output() // fails when the clipboard holds no text (an image)
	if err != nil || len(out) > wire.MaxClipboard || !utf8.Valid(out) {
		return "", false
	}
	return string(out), true
}

// setClipboard puts the viewer's clipboard text on the host.
func (s *session) setClipboard(text string) {
	s.mu.Lock()
	skip := !s.clipSync || text == s.clipLast || !utf8.ValidString(text)
	if !skip {
		s.clipLast = text
	}
	s.mu.Unlock()
	if skip {
		return
	}
	// wl-copy forks a server that holds the selection until it's replaced. It
	// inherits stdout and stderr, so those must not be pipes Run waits on.
	cmd := exec.Command("wl-copy", "--type", textType)
	cmd.Env = s.hypr.env()
	cmd.Stdin = strings.NewReader(text)
	if err := cmd.Run(); err != nil {
		slog.Warn("setting the clipboard failed", "session", s.id, "err", err)
	}
}

func (s *session) setClipSync(on bool) {
	s.mu.Lock()
	s.clipSync = on
	s.mu.Unlock()
}
