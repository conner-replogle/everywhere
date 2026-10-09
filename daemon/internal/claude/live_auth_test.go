package claude

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// TestLiveSignedOut runs the real claude CLI with an empty config directory,
// so it's signed out: no usage, and the real sign-in is left alone.
//
//	EW_CLAUDE_LIVE=1 go test ./internal/claude -run LiveSignedOut -v
func TestLiveSignedOut(t *testing.T) {
	if os.Getenv("EW_CLAUDE_LIVE") == "" {
		t.Skip("EW_CLAUDE_LIVE not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	bin, err := FindBinary(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var env []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "ANTHROPIC_") && !strings.HasPrefix(kv, "CLAUDE_CODE_OAUTH") {
			env = append(env, kv)
		}
	}
	env = append(env, "CLAUDE_CONFIG_DIR="+t.TempDir())

	t.Run("status", func(t *testing.T) {
		st, err := Auth(ctx, bin, env)
		if err != nil {
			t.Fatal(err)
		}
		if st.LoggedIn {
			t.Fatalf("status = %+v", st)
		}
	})

	t.Run("a prompt fails with authentication_failed", func(t *testing.T) {
		s, err := Start(ctx, Options{Binary: bin, Env: env, Dir: t.TempDir()})
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		if err := s.Send(UserMessage{Content: []ContentBlock{Text("hi")}}); err != nil {
			t.Fatal(err)
		}
		var failed string
		for m := range s.Messages() {
			if m.Type == "assistant" {
				var f struct {
					Error string `json:"error"`
				}
				_ = m.Decode(&f)
				failed = f.Error
			}
			if m.Type == "result" {
				break
			}
		}
		if failed != "authentication_failed" {
			t.Fatalf("assistant error = %q", failed)
		}
	})

	t.Run("login gives a link and refuses a bad code", func(t *testing.T) {
		l, err := StartLogin(ctx, bin, env, false)
		if err != nil {
			t.Fatal(err)
		}
		defer l.Cancel()
		t.Logf("sign-in link: %.80s…", l.URL)
		if !strings.Contains(l.URL, "redirect_uri=https%3A%2F%2F") {
			t.Fatalf("the link calls back to this machine, not a page with a code: %s", l.URL)
		}
		err = l.Submit(ctx, "not-a-code#nope")
		t.Logf("bad code: %v", err)
		if err == nil || !strings.Contains(err.Error(), "Login failed") {
			t.Fatalf("Submit = %v", err)
		}
	})
}
