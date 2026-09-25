package claude

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestForkPoint(t *testing.T) {
	dir := t.TempDir()
	proj := filepath.Join(dir, "projects", "-home-me-repo")
	if err := os.MkdirAll(proj, 0o700); err != nil {
		t.Fatal(err)
	}
	transcript := `{"type":"queue-operation","sessionId":"s1"}
{"type":"user","uuid":"p1","parentUuid":null,"message":{"content":"first"}}
{"type":"attachment","uuid":"x1","parentUuid":"p1"}
{"type":"assistant","uuid":"a1","parentUuid":"x1","message":{"content":"mentions p2 in passing"}}
{"type":"user","uuid":"p2","parentUuid":"a1","message":{"content":"second"}}
`
	if err := os.WriteFile(filepath.Join(proj, "s1.jsonl"), []byte(transcript), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ id, want string }{{"p1", ""}, {"p2", "a1"}} {
		if got, err := ForkPoint(dir, "s1", c.id); err != nil || got != c.want {
			t.Errorf("ForkPoint(%s) = %q, %v; want %q", c.id, got, err, c.want)
		}
	}
	if _, err := ForkPoint(dir, "s1", "p3"); !errors.Is(err, ErrNotInTranscript) {
		t.Errorf("unknown message: %v", err)
	}
	if _, err := ForkPoint(dir, "s2", "p1"); err == nil {
		t.Error("unknown session: no error")
	}
}

func TestConfigDir(t *testing.T) {
	if got := ConfigDir([]string{"CLAUDE_CONFIG_DIR=/x"}); got != "/x" {
		t.Errorf("ConfigDir = %q", got)
	}
}
