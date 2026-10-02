package peer

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMakeDir(t *testing.T) {
	root := t.TempDir()
	got, err := makeDir(root, " new ")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, "new"); got.Path != want {
		t.Errorf("path = %q, want %q", got.Path, want)
	}
	if info, err := os.Stat(got.Path); err != nil || !info.IsDir() {
		t.Errorf("not created: %v", err)
	}
	if _, err := makeDir(root, "new"); err == nil {
		t.Error("made an existing folder again")
	}
	for _, bad := range []string{"", "..", "a/b"} {
		if _, err := makeDir(root, bad); err == nil {
			t.Errorf("made %q", bad)
		}
	}
	if _, err := makeDir(filepath.Join(root, "missing"), "x"); err == nil {
		t.Error("made a folder in a missing directory")
	}
}
