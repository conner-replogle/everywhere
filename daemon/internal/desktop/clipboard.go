package desktop

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/wire"
)

// Clipboard text goes both ways while the viewer has clipboard sync on. It
// lives in the session rather than the capture worker, so it survives capture
// restarts. On Hyprland it goes through wl-clipboard (wl-paste --watch /
// wl-copy, which use the data-control protocol).

const textType = "text/plain;charset=utf-8"

// watchClipboard sends the host's clipboard text to the viewer whenever it
// changes (not on connect: that would overwrite the viewer's own clipboard).
func (s *session) watchClipboard() {
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
			case <-time.After(2 * time.Second): // the watcher died, e.g. the compositor restarted
			}
		}
		initial := true
		err := s.host.watchClipboard(ctx, func() {
			text, ok := s.host.readClipboard(ctx)
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
		})
		if errors.Is(err, errNoClipboardWatch) {
			slog.Info("clipboard sync unavailable", "session", s.id, "err", err)
			return
		}
		if err != nil {
			slog.Warn("clipboard watch failed", "session", s.id, "err", err)
		}
	}
}

// watchClipboard runs wl-paste --watch, which prints a line per change (the
// first for the current contents).
func (h *hyprInstance) watchClipboard(ctx context.Context, changed func()) error {
	if _, err := exec.LookPath("wl-paste"); err != nil {
		return fmt.Errorf("%w: wl-clipboard is not installed", errNoClipboardWatch)
	}
	cmd := exec.CommandContext(ctx, "wl-paste", "--watch", "echo")
	cmd.Env = h.env()
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	sc := bufio.NewScanner(out)
	for sc.Scan() {
		changed()
	}
	return cmd.Wait()
}

func (h *hyprInstance) readClipboard(ctx context.Context) (string, bool) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "wl-paste", "--no-newline", "--type", "text")
	cmd.Env = h.env()
	out, err := cmd.Output() // fails when the clipboard holds no text (an image)
	if err != nil || len(out) > wire.MaxClipboard || !utf8.Valid(out) {
		return "", false
	}
	return string(out), true
}

func (h *hyprInstance) writeClipboard(text string) error {
	// wl-copy forks a server that holds the selection until it's replaced. It
	// inherits stdout and stderr, so those must not be pipes Run waits on.
	cmd := exec.Command("wl-copy", "--type", textType)
	cmd.Env = h.env()
	cmd.Stdin = strings.NewReader(text)
	return cmd.Run()
}

// writeClipboardText puts text on the host's clipboard.
func writeClipboardText(h desktopHost, text string) error {
	if !utf8.ValidString(text) || len(text) > wire.MaxClipboard {
		return errors.New("the text must be valid UTF-8 and at most 200 KiB")
	}
	return h.writeClipboard(text)
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
	if err := writeClipboardText(s.host, text); err != nil {
		slog.Warn("setting the clipboard failed", "session", s.id, "err", err)
	}
}

func (s *session) setClipSync(on bool) {
	s.mu.Lock()
	s.clipSync = on
	s.mu.Unlock()
}
