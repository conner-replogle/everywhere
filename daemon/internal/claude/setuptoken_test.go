//go:build !windows

package claude

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// fakeSetupToken stands in for `claude setup-token`: a hyperlinked sign-in
// URL, a prompt for the code, and the token (or a refusal) wrapped in colour.
func fakeSetupToken(t *testing.T, accept string) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "claude")
	script := `#!/bin/sh
[ "$1" = setup-token ] || exit 2
[ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] || { echo "token leaked in"; exit 3; }
printf 'Browser didn'"'"'t open? Use the url below\n'
printf '\033]8;id=1;https://claude.com/cai/oauth/authorize?code=true&state=abc\033\\https://claude.com/cai/oauth\033]8;;\033\\\n'
printf 'Paste code here if prompted > '
read code
if [ "$code" = "` + accept + `" ]; then
  printf '\033[32mYour OAuth token (valid for 1 year):\033[0m\n\033[1msk-ant-oat01-abcdefghijklmnopqrstuvwxyz_0123-XYZ\033[0m\n'
  sleep 30
else
  printf 'OAuth error: Invalid code\n'
  exit 1
fi
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

func TestTokenLogin(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	l, err := StartTokenLogin(ctx, fakeSetupToken(t, "good-code"), WithToken(nil, "sk-ant-oat01-old"))
	if err != nil {
		t.Fatal(err)
	}
	if l.URL != "https://claude.com/cai/oauth/authorize?code=true&state=abc" {
		t.Fatalf("URL = %q", l.URL)
	}
	if err := l.Submit(ctx, "good-code"); err != nil {
		t.Fatal(err)
	}
	if got := l.Token(); got != "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz_0123-XYZ" {
		t.Fatalf("token = %q", got)
	}
}

func TestTokenLoginRefused(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	l, err := StartTokenLogin(ctx, fakeSetupToken(t, "good-code"), nil)
	if err != nil {
		t.Fatal(err)
	}
	err = l.Submit(ctx, "bad-code")
	if err == nil || l.Token() != "" {
		t.Fatalf("Submit = %v, token %q", err, l.Token())
	}
	if want := "claude setup-token: OAuth error: Invalid code"; err.Error() != want {
		t.Fatalf("error = %q, want %q", err, want)
	}
}

func TestWithToken(t *testing.T) {
	env := WithToken([]string{"A=1", TokenEnv + "=old"}, "new")
	if len(env) != 2 || env[0] != "A=1" || env[1] != TokenEnv+"=new" {
		t.Fatalf("env = %q", env)
	}
	if env := WithToken([]string{TokenEnv + "=old"}, ""); len(env) != 0 {
		t.Fatalf("env = %q", env)
	}
}
