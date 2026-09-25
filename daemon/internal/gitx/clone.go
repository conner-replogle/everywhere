package gitx

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// CloneProgress is where a clone is, from git's --progress output.
type CloneProgress struct {
	// Stage: connecting, counting, receiving, resolving or checkout.
	Stage string
	// Percent of the stage, -1 when git hasn't said.
	Percent int
	// Detail is git's extra, e.g. "12.30 MiB | 5.00 MiB/s".
	Detail string
}

var (
	stagePrefixes = []struct{ prefix, stage string }{
		{"remote: Enumerating objects", "counting"},
		{"remote: Counting objects", "counting"},
		{"remote: Compressing objects", "counting"},
		{"Receiving objects", "receiving"},
		{"Resolving deltas", "resolving"},
		{"Updating files", "checkout"},
		{"Checking out files", "checkout"},
	}
	percentRe = regexp.MustCompile(`:\s+(\d+)%\s+\(\d+/\d+\)(?:,\s*(.*?))?\s*(?:,\s*done\.)?\s*$`)
)

// parseProgress reads one of git's progress redraws; ok is false for other
// lines (errors, hints).
func parseProgress(line string) (p CloneProgress, ok bool) {
	for _, sp := range stagePrefixes {
		if !strings.HasPrefix(line, sp.prefix) {
			continue
		}
		p = CloneProgress{Stage: sp.stage, Percent: -1}
		if m := percentRe.FindStringSubmatch(line); m != nil {
			p.Percent, _ = strconv.Atoi(m[1])
			p.Detail = strings.TrimSpace(strings.TrimSuffix(strings.TrimSuffix(strings.TrimSpace(m[2]), "done."), ","))
		}
		return p, true
	}
	return p, false
}

// RedactURL drops credentials and the query from a remote URL.
func RedactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return raw // scp-like (git@host:owner/repo) or not a URL
	}
	u.User = nil
	u.RawQuery = ""
	return u.String()
}

// Clone clones remote into dir, which must be missing or empty. token, if
// set, answers git's HTTPS credential prompt (GitHub: any user name, the
// token as password) without landing in argv or the repo's config.
func Clone(ctx context.Context, remote, dir, token string, progress func(CloneProgress)) error {
	args := []string{}
	env := append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0", "GIT_PROGRESS_DELAY=0", "GCM_INTERACTIVE=never", "LC_ALL=C")
	if token != "" {
		// Reset inherited helpers so the token is the only answer, then echo it from the env.
		args = append(args,
			"-c", "credential.helper=",
			"-c", `credential.helper=!f() { test "$1" = get && echo username=x-access-token && echo "password=$EW_GIT_TOKEN"; }; f`)
		env = append(env, "EW_GIT_TOKEN="+token)
	}
	args = append(args, "clone", "--progress", "--", remote, dir)
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Env = env
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	// Progress redraws end in \r, other messages in \n. Keep the last few
	// messages for the error.
	var tail []string
	sc := bufio.NewScanner(stderr)
	sc.Split(splitCRLF)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		if p, ok := parseProgress(line); ok {
			if progress != nil {
				progress(p)
			}
			continue
		}
		if strings.HasPrefix(line, "Cloning into") {
			continue
		}
		tail = append(tail, RedactURL(line))
		if len(tail) > 4 {
			tail = tail[1:]
		}
	}
	if err := cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if len(tail) > 0 {
			return fmt.Errorf("git clone: %s", strings.Join(tail, "; "))
		}
		return fmt.Errorf("git clone: %w", err)
	}
	return nil
}

func splitCRLF(data []byte, atEOF bool) (int, []byte, error) {
	if i := bytes.IndexAny(data, "\r\n"); i >= 0 {
		return i + 1, data[:i], nil
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}
