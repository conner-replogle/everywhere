// Package gitx is the git plumbing behind claude threads that run in their
// own worktree.
package gitx

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// run executes git in dir and returns its trimmed stdout, or stderr as the
// error.
func run(ctx context.Context, dir string, args ...string) (string, error) {
	return runEnv(ctx, dir, nil, args...)
}

// runEnv is run with extra environment variables.
func runEnv(ctx context.Context, dir string, env []string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	// Never prompt, and keep messages in English.
	cmd.Env = append(append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C"), env...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("git %s: %s", args[0], msg)
	}
	return strings.TrimSpace(stdout.String()), nil
}

// IsRepo reports whether dir is inside a git work tree.
func IsRepo(ctx context.Context, dir string) bool {
	out, err := run(ctx, dir, "rev-parse", "--is-inside-work-tree")
	return err == nil && out == "true"
}

// Prefix is dir's path relative to the top of its work tree ("" at the top).
func Prefix(ctx context.Context, dir string) (string, error) {
	return run(ctx, dir, "rev-parse", "--show-prefix")
}

// HasCommit reports whether ref resolves to a commit.
func HasCommit(ctx context.Context, dir, ref string) bool {
	_, err := run(ctx, dir, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	return err == nil
}

// CurrentBranch is the checked-out branch, or "" when HEAD is detached.
func CurrentBranch(ctx context.Context, dir string) string {
	out, _ := run(ctx, dir, "symbolic-ref", "--quiet", "--short", "HEAD")
	return out
}

// Branches lists local branches, most recently committed first.
func Branches(ctx context.Context, dir string) ([]string, error) {
	out, err := run(ctx, dir, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads")
	if err != nil || out == "" {
		return []string{}, err
	}
	return strings.Split(out, "\n"), nil
}

// AddWorktree creates a worktree at path on a new branch started from base.
// Only committed state carries over; uncommitted changes stay in the
// original checkout.
func AddWorktree(ctx context.Context, repo, path, branch, base string) error {
	if !HasCommit(ctx, repo, base) {
		return fmt.Errorf("a worktree needs a base branch with at least one commit; %q has none", base)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	_, err := run(ctx, repo, "worktree", "add", "-b", branch, path, base)
	return err
}

// EnsureWorktree recreates a worktree on its existing branch if the directory
// has gone missing (deleted by hand, or pruned).
func EnsureWorktree(ctx context.Context, repo, path, branch string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	_, _ = run(ctx, repo, "worktree", "prune")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	_, err := run(ctx, repo, "worktree", "add", path, branch)
	return err
}

// RemoveWorktree deletes a worktree and whatever uncommitted changes it
// holds. Its branch is kept, so committed work survives.
func RemoveWorktree(ctx context.Context, repo, path string) error {
	_, err := run(ctx, repo, "worktree", "remove", "--force", path)
	if err != nil {
		if _, statErr := os.Stat(path); os.IsNotExist(statErr) {
			_, _ = run(ctx, repo, "worktree", "prune")
			return nil
		}
	}
	return err
}
