package claude

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ErrNotInstalled means no claude executable could be found.
var ErrNotInstalled = errors.New("claude: not installed (no claude executable found)")

// FindBinary locates the claude executable. The daemon usually runs under
// systemd, whose PATH lacks ~/.local/bin (where the native installer puts
// claude), so after PATH it asks the user's login shell and then checks the
// installers' default locations.
func FindBinary(ctx context.Context) (string, error) {
	if p, err := exec.LookPath("claude"); err == nil {
		return p, nil
	}
	if shell := os.Getenv("SHELL"); shell != "" {
		out, err := exec.CommandContext(ctx, shell, "-lc", "command -v claude").Output()
		if p := strings.TrimSpace(string(out)); err == nil && filepath.IsAbs(p) && isExecutable(p) {
			return p, nil
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		for _, p := range []string{
			filepath.Join(home, ".local", "bin", "claude"),
			filepath.Join(home, ".claude", "local", "claude"),
		} {
			if isExecutable(p) {
				return p, nil
			}
		}
	}
	return "", ErrNotInstalled
}

// Version returns the CLI's version, e.g. "2.1.281".
func Version(ctx context.Context, bin string) (string, error) {
	out, err := exec.CommandContext(ctx, bin, "--version").Output()
	if err != nil {
		return "", err
	}
	v, _, _ := strings.Cut(strings.TrimSpace(string(out)), " ")
	return v, nil
}

func isExecutable(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir() && info.Mode()&0o111 != 0
}
