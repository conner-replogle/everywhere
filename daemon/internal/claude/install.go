package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// Package is Claude Code's npm package, whose latest version is the newest
// release.
const Package = "@anthropic-ai/claude-code"

// Resolve is the executable that running bin with env actually runs: bin
// with symlinks resolved, looking through a mise shim to the claude it
// dispatches to (mise's own install when active here, else the next claude
// on PATH).
func Resolve(bin string, env []string) (string, error) {
	real, err := filepath.EvalSymlinks(bin)
	if err != nil || filepath.Base(real) != "mise" {
		return real, err
	}
	cmd := exec.Command(real, "which", "claude")
	cmd.Env = env
	cmd.Dir, _ = os.UserHomeDir()
	if out, err := cmd.Output(); err == nil {
		if p := strings.TrimSpace(string(out)); filepath.IsAbs(p) {
			return filepath.EvalSymlinks(p)
		}
	}
	next := lookPath("claude", env, filepath.Dir(bin))
	if next == "" {
		return real, nil
	}
	return filepath.EvalSymlinks(next)
}

// Build identifies the claude that bin runs as built: its real path
// (installers keep one file per version, or rewrite it in place) with its
// size and modification time. It changes whenever claude is updated.
func Build(bin string, env []string) (string, error) {
	real, err := Resolve(bin, env)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(real)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s:%d:%d", real, info.Size(), info.ModTime().UnixNano()), nil
}

// UpdateCommand is the command that updates the claude at bin, judged by
// where it's installed, or nil when that isn't clear: an update is only run
// by the installer that evidently owns the executable (as in t3code). env is
// what the command runs with; its PATH finds npm.
func UpdateCommand(bin string, env []string) []string {
	real, err := Resolve(bin, env)
	if err != nil {
		return nil
	}
	real = filepath.ToSlash(real)

	// The native installer: one file per version under
	// ~/.local/share/claude/versions, linked from ~/.local/bin/claude. It
	// updates itself.
	if i := strings.Index(real, "/.local/share/claude/"); i >= 0 {
		if link := real[:i] + "/.local/bin/claude"; isExecutable(link) {
			return []string{link, "update"}
		}
		return []string{real, "update"}
	}

	// An npm global install: <prefix>/lib/node_modules/@anthropic-ai/claude-code/…
	// (not a project's node_modules, and not mise's npm backend, which
	// manages its own tool versions).
	i := strings.LastIndex(real, "/lib/node_modules/"+Package+"/")
	if i < 0 || strings.Contains(real[:i], "/node_modules/") {
		return nil
	}
	prefix := real[:i]
	if strings.Contains(prefix, "/mise/installs/") && !strings.Contains(prefix, "/mise/installs/node/") {
		return nil
	}
	if prefix == "" {
		prefix = "/"
	}
	// A system prefix needs root; that's for the user to run.
	if unix.Access(filepath.Join(prefix, "lib", "node_modules"), unix.W_OK) != nil {
		return nil
	}
	npm := filepath.Join(prefix, "bin", "npm")
	if !isExecutable(npm) {
		if npm = lookPath("npm", env, ""); npm == "" {
			return nil
		}
	}
	return []string{npm, "install", "--global", "--prefix", prefix, Package + "@latest"}
}

// lookPath finds name on the PATH in env (or the daemon's own, if env has
// none), passing over the directory skip.
func lookPath(name string, env []string, skip string) string {
	path := os.Getenv("PATH")
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, "PATH="); ok {
			path = v
		}
	}
	for _, dir := range filepath.SplitList(path) {
		if p := filepath.Join(dir, name); dir != "" && filepath.Clean(dir) != skip && isExecutable(p) {
			return p
		}
	}
	return ""
}

// LatestVersion is the newest Claude Code release, from the npm registry.
func LatestVersion(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://registry.npmjs.org/"+Package+"/latest", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("npm registry: %s", resp.Status)
	}
	var body struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	if body.Version == "" {
		return "", fmt.Errorf("npm registry: no version for %s", Package)
	}
	return body.Version, nil
}
