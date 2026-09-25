package gitx

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseProgress(t *testing.T) {
	cases := []struct {
		line          string
		stage, detail string
		pct           int
		ok            bool
	}{
		{"Receiving objects:  45% (450/1000), 12.30 MiB | 5.00 MiB/s", "receiving", "12.30 MiB | 5.00 MiB/s", 45, true},
		{"Resolving deltas: 100% (20/20), done.", "resolving", "", 100, true},
		{"remote: Counting objects:  10% (1/10)", "counting", "", 10, true},
		{"remote: Enumerating objects: 5, done.", "counting", "", -1, true},
		{"fatal: repository 'x' not found", "", "", 0, false},
	}
	for _, c := range cases {
		p, ok := parseProgress(c.line)
		if ok != c.ok || (ok && (p.Stage != c.stage || p.Percent != c.pct || p.Detail != c.detail)) {
			t.Errorf("parseProgress(%q) = %+v, %v", c.line, p, ok)
		}
	}
}

func TestRedactURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://user:tok@github.com/o/r.git?x=1":   "https://github.com/o/r.git",
		"git@github.com:o/r.git":                    "git@github.com:o/r.git",
		"fatal: unable to access 'https://a:b@h/x'": "fatal: unable to access 'https://a:b@h/x'",
	} {
		if got := RedactURL(in); got != want {
			t.Errorf("RedactURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCloneLocal(t *testing.T) {
	src := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = src
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	dest := filepath.Join(t.TempDir(), "clone")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Clone(context.Background(), "file://"+src, dest, "secret-token", nil); err != nil {
		t.Fatal(err)
	}
	cfg, err := os.ReadFile(filepath.Join(dest, ".git", "config"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(cfg), "secret-token") || strings.Contains(string(cfg), "helper") {
		t.Fatalf("token or helper leaked into config:\n%s", cfg)
	}
	if err := Clone(context.Background(), "file:///nonexistent/repo", filepath.Join(t.TempDir(), "x"), "", nil); err == nil ||
		!strings.Contains(err.Error(), "git clone:") {
		t.Fatalf("clone of a missing repo: %v", err)
	}
}
