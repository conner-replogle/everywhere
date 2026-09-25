package gitx

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Status is where a checkout stands: its branch against its upstream, its
// uncommitted changes, and the default branch against origin's.
type Status struct {
	IsRepo bool `json:"isRepo"`
	// Branch is the checked-out branch; "" when detached (Head says where).
	Branch   string `json:"branch"`
	Head     string `json:"head"` // short commit, "" before the first commit
	Upstream string `json:"upstream,omitempty"`
	Ahead    int    `json:"ahead"`
	Behind   int    `json:"behind"`

	// Uncommitted changes: files staged, changed but unstaged, and untracked;
	// lines added and removed against HEAD in tracked files.
	Staged     int `json:"staged"`
	Unstaged   int `json:"unstaged"`
	Untracked  int `json:"untracked"`
	Conflicted int `json:"conflicted"`
	Insertions int `json:"insertions"`
	Deletions  int `json:"deletions"`

	// Worktree: this checkout is a linked worktree (not the repo's main one).
	Worktree bool   `json:"worktree"`
	Root     string `json:"root"` // top of the checkout

	// DefaultBranch is origin's (e.g. "main"); "" without an origin.
	DefaultBranch string `json:"defaultBranch,omitempty"`
	// DefaultBehind: commits origin's default branch has that the local one
	// doesn't (the local main is out of date). -1 without a local copy.
	DefaultBehind int `json:"defaultBehind"`
	// AheadOfDefault and BehindDefault compare HEAD with origin's default
	// branch, when HEAD isn't on it.
	AheadOfDefault int `json:"aheadOfDefault"`
	BehindDefault  int `json:"behindDefault"`
}

// ReadStatus reads dir's status from what's already fetched; it never
// touches the network.
func ReadStatus(ctx context.Context, dir string) (Status, error) {
	st := Status{DefaultBehind: -1}
	paths, err := run(ctx, dir, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir")
	if err != nil {
		return st, nil // not a repo (or no git): not an error to the caller
	}
	p := strings.Split(paths, "\n")
	if len(p) < 3 {
		return st, nil
	}
	st.IsRepo, st.Root = true, p[0]
	st.Worktree = filepath.Clean(p[1]) != filepath.Clean(p[2])

	// A commit or rebase in progress holds the index lock; git status would
	// wait or fail. Try again on the next refresh.
	if _, err := os.Stat(filepath.Join(p[1], "index.lock")); err == nil {
		return st, nil
	}
	out, err := run(ctx, dir, "status", "--porcelain=v2", "--branch", "--untracked-files=normal")
	if err != nil {
		return st, err
	}
	parsePorcelain(&st, out)

	if st.Head != "" {
		if num, err := run(ctx, dir, "diff", "HEAD", "--numstat", "--no-renames", "--"); err == nil {
			st.Insertions, st.Deletions = sumNumstat(num)
		}
	}

	st.DefaultBranch = defaultBranch(ctx, dir)
	if st.DefaultBranch != "" {
		remote := "refs/remotes/origin/" + st.DefaultBranch
		local := "refs/heads/" + st.DefaultBranch
		if HasCommit(ctx, dir, local) {
			if n, err := run(ctx, dir, "rev-list", "--count", local+".."+remote); err == nil {
				st.DefaultBehind, _ = strconv.Atoi(n)
			}
		}
		if st.Head != "" && st.Branch != st.DefaultBranch {
			if lr, err := run(ctx, dir, "rev-list", "--left-right", "--count", "HEAD..."+remote); err == nil {
				st.AheadOfDefault, st.BehindDefault = leftRight(lr)
			}
		}
	}
	return st, nil
}

// parsePorcelain reads `git status --porcelain=v2 --branch`.
func parsePorcelain(st *Status, out string) {
	for _, line := range strings.Split(out, "\n") {
		switch {
		case strings.HasPrefix(line, "# branch.oid "):
			if oid := strings.TrimPrefix(line, "# branch.oid "); oid != "(initial)" && len(oid) >= 7 {
				st.Head = oid[:7]
			}
		case strings.HasPrefix(line, "# branch.head "):
			if h := strings.TrimPrefix(line, "# branch.head "); h != "(detached)" {
				st.Branch = h
			}
		case strings.HasPrefix(line, "# branch.upstream "):
			st.Upstream = strings.TrimPrefix(line, "# branch.upstream ")
		case strings.HasPrefix(line, "# branch.ab "):
			for _, f := range strings.Fields(strings.TrimPrefix(line, "# branch.ab ")) {
				n, _ := strconv.Atoi(f[1:])
				if f[0] == '+' {
					st.Ahead = n
				} else {
					st.Behind = n
				}
			}
		case strings.HasPrefix(line, "1 "), strings.HasPrefix(line, "2 "):
			// "1 XY ..." — X is the index, Y the work tree; '.' is unchanged.
			if len(line) >= 4 {
				if line[2] != '.' {
					st.Staged++
				}
				if line[3] != '.' {
					st.Unstaged++
				}
			}
		case strings.HasPrefix(line, "u "):
			st.Conflicted++
		case strings.HasPrefix(line, "? "):
			st.Untracked++
		}
	}
}

func sumNumstat(out string) (ins, del int) {
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		// Binary files show "-".
		a, _ := strconv.Atoi(f[0])
		d, _ := strconv.Atoi(f[1])
		ins += a
		del += d
	}
	return ins, del
}

func leftRight(out string) (left, right int) {
	f := strings.Fields(out)
	if len(f) == 2 {
		left, _ = strconv.Atoi(f[0])
		right, _ = strconv.Atoi(f[1])
	}
	return left, right
}

// defaultBranch is origin's default branch: what origin/HEAD points at, or
// else main or master if origin has one.
func defaultBranch(ctx context.Context, dir string) string {
	if ref, err := run(ctx, dir, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"); err == nil {
		return strings.TrimPrefix(ref, "origin/")
	}
	for _, b := range []string{"main", "master"} {
		if HasCommit(ctx, dir, "refs/remotes/origin/"+b) {
			return b
		}
	}
	return ""
}

// HasRemote reports whether dir's repo has a remote named name.
func HasRemote(ctx context.Context, dir, name string) bool {
	_, err := run(ctx, dir, "remote", "get-url", name)
	return err == nil
}

// CommonDir is the repo's shared .git directory, the same for all of its
// worktrees.
func CommonDir(ctx context.Context, dir string) (string, error) {
	return run(ctx, dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
}

// Fetch updates origin's refs without prompting for credentials. If the
// repo doesn't know origin's default branch yet, it asks origin once.
func Fetch(ctx context.Context, dir string) error {
	if _, err := runNoAsk(ctx, dir, "fetch", "--quiet", "--no-tags", "origin"); err != nil {
		return err
	}
	if _, err := run(ctx, dir, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"); err != nil {
		_, _ = runNoAsk(ctx, dir, "remote", "set-head", "origin", "--auto")
	}
	return nil
}

// PullFastForward merges the upstream into the current branch, only if
// that's a fast-forward.
func PullFastForward(ctx context.Context, dir string) error {
	_, err := runNoAsk(ctx, dir, "pull", "--ff-only", "--no-rebase", "--quiet")
	return err
}

// FastForwardBranch moves a local branch that isn't checked out (e.g. main
// while working on a feature) up to origin's copy, if that's a fast-forward.
func FastForwardBranch(ctx context.Context, dir, branch string) error {
	_, err := runNoAsk(ctx, dir, "fetch", "--quiet", "--no-tags", "origin", branch+":"+branch)
	return err
}

// runNoAsk is run for commands that may reach a remote: no password
// prompts, no GUI askpass.
func runNoAsk(ctx context.Context, dir string, args ...string) (string, error) {
	// The daemon has no terminal, so ssh can't prompt either.
	return runEnv(ctx, dir, []string{"GIT_ASKPASS=", "SSH_ASKPASS=", "SSH_ASKPASS_REQUIRE=never", "GCM_INTERACTIVE=never"}, args...)
}
