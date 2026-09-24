package gitx

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
)

func gitCmd(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func newRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	gitCmd(t, dir, "init", "-q", "-b", "main")
	if err := os.MkdirAll(filepath.Join(dir, "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app", "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-q", "-m", "init")
	return dir
}

func TestRepoInfo(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	if !IsRepo(ctx, repo) || IsRepo(ctx, t.TempDir()) {
		t.Fatal("IsRepo wrong")
	}
	if p, err := Prefix(ctx, filepath.Join(repo, "app")); err != nil || p != "app/" {
		t.Fatalf("Prefix = %q, %v", p, err)
	}
	gitCmd(t, repo, "branch", "feature")
	if b := CurrentBranch(ctx, repo); b != "main" {
		t.Fatalf("CurrentBranch = %q", b)
	}
	if bs, err := Branches(ctx, repo); err != nil || !slices.Contains(bs, "feature") || !slices.Contains(bs, "main") {
		t.Fatalf("Branches = %v, %v", bs, err)
	}
}

func TestWorktreeLifecycle(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	// Uncommitted changes stay in the original checkout.
	if err := os.WriteFile(filepath.Join(repo, "dirty.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	wt := filepath.Join(t.TempDir(), "worktrees", "repo", "thread1")
	if err := AddWorktree(ctx, repo, wt, "everywhere/thread1", "main"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(wt, "app", "main.go")); err != nil {
		t.Fatalf("worktree missing committed file: %v", err)
	}
	if _, err := os.Stat(filepath.Join(wt, "dirty.txt")); !os.IsNotExist(err) {
		t.Fatal("uncommitted file leaked into the worktree")
	}
	if b := CurrentBranch(ctx, wt); b != "everywhere/thread1" {
		t.Fatalf("worktree branch = %q", b)
	}
	if err := AddWorktree(ctx, repo, wt+"x", "everywhere/other", "nope"); err == nil {
		t.Fatal("AddWorktree accepted a missing base")
	}

	// A deleted directory comes back on the same branch.
	if err := os.RemoveAll(wt); err != nil {
		t.Fatal(err)
	}
	if err := EnsureWorktree(ctx, repo, wt, "everywhere/thread1"); err != nil {
		t.Fatal(err)
	}
	if b := CurrentBranch(ctx, wt); b != "everywhere/thread1" {
		t.Fatalf("recreated worktree branch = %q", b)
	}

	// Removing discards uncommitted work but keeps the branch.
	if err := os.WriteFile(filepath.Join(wt, "scratch.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := RemoveWorktree(ctx, repo, wt); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wt); !os.IsNotExist(err) {
		t.Fatal("worktree directory survived removal")
	}
	if bs, _ := Branches(ctx, repo); !slices.Contains(bs, "everywhere/thread1") {
		t.Fatalf("branch was deleted: %v", bs)
	}
	if err := RemoveWorktree(ctx, repo, wt); err != nil {
		t.Fatalf("removing an already-removed worktree: %v", err)
	}
}
