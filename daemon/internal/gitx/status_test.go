package gitx

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.email=t@t", "-c", "user.name=t"}, args...)...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestReadStatus(t *testing.T) {
	ctx := context.Background()
	origin := t.TempDir()
	git(t, origin, "init", "-q", "-b", "main")
	git(t, origin, "commit", "-q", "--allow-empty", "-m", "one")

	clone := filepath.Join(t.TempDir(), "clone")
	git(t, filepath.Dir(clone), "clone", "-q", origin, clone)

	st, err := ReadStatus(ctx, clone)
	if err != nil || !st.IsRepo || st.Branch != "main" || st.Upstream != "origin/main" || st.DefaultBranch != "main" {
		t.Fatalf("fresh clone: %+v, %v", st, err)
	}
	if st.Ahead != 0 || st.Behind != 0 || st.DefaultBehind != 0 || st.Worktree {
		t.Fatalf("fresh clone counts: %+v", st)
	}

	// Two commits on origin, one local, some local edits.
	git(t, origin, "commit", "-q", "--allow-empty", "-m", "two")
	git(t, origin, "commit", "-q", "--allow-empty", "-m", "three")
	git(t, clone, "commit", "-q", "--allow-empty", "-m", "mine")
	if err := Fetch(ctx, clone); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(clone, "a.txt"), []byte("1\n2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(clone, "new.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, clone, "add", "a.txt")
	st, _ = ReadStatus(ctx, clone)
	if st.Ahead != 1 || st.Behind != 2 || st.Staged != 1 || st.Untracked != 1 || st.Insertions != 2 || st.DefaultBehind != 2 {
		t.Fatalf("diverged: %+v", st)
	}

	// A worktree on a feature branch: main is out of date and it's behind origin/main.
	wt := filepath.Join(t.TempDir(), "wt")
	git(t, clone, "worktree", "add", "-q", "-b", "feature", wt, "HEAD")
	st, _ = ReadStatus(ctx, wt)
	if !st.Worktree || st.Branch != "feature" || st.DefaultBehind != 2 || st.AheadOfDefault != 1 || st.BehindDefault != 2 {
		t.Fatalf("worktree: %+v", st)
	}

	st, _ = ReadStatus(ctx, t.TempDir())
	if st.IsRepo {
		t.Fatalf("plain dir is a repo: %+v", st)
	}
}
