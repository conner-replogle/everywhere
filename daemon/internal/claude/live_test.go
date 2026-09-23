package claude

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestLive runs against the real claude CLI and spends a few cents of the
// logged-in account's usage, so it only runs with EW_CLAUDE_LIVE=1.
//
//	EW_CLAUDE_LIVE=1 go test ./internal/claude -run Live -v
func TestLive(t *testing.T) {
	if os.Getenv("EW_CLAUDE_LIVE") == "" {
		t.Skip("EW_CLAUDE_LIVE not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	bin, err := FindBinary(ctx)
	if err != nil {
		t.Fatal(err)
	}
	version, _ := Version(ctx, bin)
	t.Logf("claude %s at %s", version, bin)

	dir := t.TempDir()
	opts := Options{
		Binary: bin,
		Dir:    dir,
		Model:  "haiku",
		// Skip user settings so their allow rules can't pre-approve tools.
		Args: []string{"--setting-sources=project"},
	}

	var sessionID string
	t.Run("permission round trip", func(t *testing.T) {
		s := startLive(t, ctx, opts)
		if s.Init().Account == (Account{}) {
			t.Error("initialize returned no account info")
		}
		send(t, s, "Use the Write tool to create hello.txt containing exactly: hi. Then reply with the single word done.")
		prompted := false
		for m := range s.Messages() {
			switch {
			case m.Permission != nil:
				if m.Permission.ToolName != "Write" {
					t.Fatalf("unexpected tool %q", m.Permission.ToolName)
				}
				prompted = true
				if err := s.Respond(m.Permission, Allow()); err != nil {
					t.Fatal(err)
				}
			case m.Type == "result":
				sessionID = m.SessionID
				if !prompted {
					t.Fatal("turn ended without a permission prompt")
				}
				b, err := os.ReadFile(filepath.Join(dir, "hello.txt"))
				if err != nil || !strings.HasPrefix(strings.TrimSpace(string(b)), "hi") {
					t.Fatalf("hello.txt = %q, %v", b, err)
				}
				return
			}
		}
		t.Fatalf("session ended: %v", s.Err())
	})

	t.Run("resume", func(t *testing.T) {
		if sessionID == "" {
			t.Skip("no session to resume")
		}
		o := opts
		o.Resume = sessionID
		s := startLive(t, ctx, o)
		send(t, s, "What is the name of the file you just created? Reply with the file name only.")
		m := waitForLive(t, s, "result")
		if got := resultText(t, m); !strings.Contains(got, "hello.txt") {
			t.Fatalf("resumed session answered %q", got)
		}
		if m.SessionID != sessionID {
			t.Fatalf("resumed session id %q, want %q", m.SessionID, sessionID)
		}
	})

	t.Run("interrupt", func(t *testing.T) {
		s := startLive(t, ctx, opts)
		send(t, s, "Write a 2000-word essay about the history of the terminal emulator.")
		waitForLive(t, s, "stream_event")
		if err := s.Interrupt(ctx); err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		waitForLive(t, s, "result")
		t.Logf("turn ended %v after interrupt", time.Since(start))
	})
}

func startLive(t *testing.T, ctx context.Context, o Options) *Session {
	t.Helper()
	s, err := Start(ctx, o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		go func() {
			for range s.Messages() {
			}
		}()
		s.Close()
	})
	return s
}

func waitForLive(t *testing.T, s *Session, typ string) Message {
	t.Helper()
	for m := range s.Messages() {
		if m.Type == typ {
			return m
		}
	}
	t.Fatalf("session ended waiting for %q: %v", typ, s.Err())
	return Message{}
}
