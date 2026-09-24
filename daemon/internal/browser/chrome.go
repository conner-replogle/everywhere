package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ErrNotInstalled means no Chromium-based browser could be found.
var ErrNotInstalled = errors.New("no Chrome or Chromium found on this device (set EVERYWHERE_CHROME to its path)")

// findChrome locates a Chromium-based browser: $EVERYWHERE_CHROME, PATH, the
// login shell's PATH (systemd's is minimal), the macOS app bundles, then
// Playwright's download cache.
func findChrome(ctx context.Context) (string, error) {
	if p := os.Getenv("EVERYWHERE_CHROME"); p != "" {
		return p, nil
	}
	names := []string{"google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome", "chrome-headless-shell", "microsoft-edge"}
	for _, n := range names {
		if p, err := exec.LookPath(n); err == nil && !isSnapStub(p) {
			return p, nil
		}
	}
	if shell := os.Getenv("SHELL"); shell != "" {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, shell, "-lc", "command -v "+strings.Join(names, " ")).Output()
		if err == nil || len(out) > 0 {
			for _, line := range strings.Split(string(out), "\n") {
				if p := strings.TrimSpace(line); filepath.IsAbs(p) && isExecutable(p) && !isSnapStub(p) {
					return p, nil
				}
			}
		}
	}
	var candidates []string
	if runtime.GOOS == "darwin" {
		candidates = append(candidates,
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		)
	}
	if home, err := os.UserHomeDir(); err == nil {
		cache := filepath.Join(home, ".cache", "ms-playwright")
		for _, pattern := range []string{
			"chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell",
			"chromium-*/chrome-linux*/chrome",
		} {
			matches, _ := filepath.Glob(filepath.Join(cache, pattern))
			// Newest revision last.
			for i := len(matches) - 1; i >= 0; i-- {
				candidates = append(candidates, matches[i])
			}
		}
	}
	for _, p := range candidates {
		if isExecutable(p) {
			return p, nil
		}
	}
	return "", ErrNotInstalled
}

// isSnapStub reports whether p is Ubuntu's snap Chromium, or the script
// that installs it; neither passes the DevTools pipe through.
func isSnapStub(p string) bool {
	if real, err := filepath.EvalSymlinks(p); err == nil && strings.HasPrefix(real, "/snap/") {
		return true
	}
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	head := make([]byte, 4096)
	n, _ := f.Read(head)
	return strings.HasPrefix(string(head[:n]), "#!") && strings.Contains(string(head[:n]), "snap")
}

func isExecutable(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir() && info.Mode()&0o111 != 0
}

// chrome is one running browser process.
type chrome struct {
	conn *conn
	cmd  *exec.Cmd
	done chan struct{} // closed when the process has exited
	// userAgent is the browser's own UA with "HeadlessChrome" made "Chrome",
	// since some sites (Cloudflare's bot check among them) reject headless.
	userAgent string
}

// launchChrome starts a headless browser with its profile in profileDir.
// Events arrive on onEvent; onExit runs once when the browser goes away.
func launchChrome(ctx context.Context, profileDir string, onEvent func(string, string, json.RawMessage), onExit func(error)) (*chrome, error) {
	bin, err := findChrome(ctx)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		return nil, err
	}
	args := []string{
		"--headless",
		// Screencast frames ignore the emulated device scale factor unless
		// the browser itself renders at it; each tab's override still
		// brings 1x viewers back down.
		"--force-device-scale-factor=2",
		"--remote-debugging-pipe",
		"--user-data-dir=" + profileDir,
		"--no-first-run",
		"--no-default-browser-check",
		"--mute-audio",
		"--hide-crash-restore-bubble",
		"--password-store=basic",
		"--use-mock-keychain",
		// Tabs nobody is looking at locally are still being watched remotely.
		"--disable-background-timer-throttling",
		"--disable-backgrounding-occluded-windows",
		"--disable-renderer-backgrounding",
		"--disable-extensions",
		"--disable-component-extensions-with-background-pages",
		"--disable-features=Translate,MediaRouter,OptimizationHints",
		"about:blank",
	}
	if os.Geteuid() == 0 {
		args = append(args, "--no-sandbox")
	}
	// Chrome reads commands from fd 3 and writes to fd 4.
	cmdR, cmdW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		_ = cmdR.Close()
		_ = cmdW.Close()
		return nil, err
	}
	cmd := exec.Command(bin, args...)
	cmd.ExtraFiles = []*os.File{cmdR, outW}
	cmd.SysProcAttr = sysProcAttr()
	if err := cmd.Start(); err != nil {
		for _, f := range []*os.File{cmdR, cmdW, outR, outW} {
			_ = f.Close()
		}
		return nil, fmt.Errorf("start %s: %w", bin, err)
	}
	_ = cmdR.Close()
	_ = outW.Close()
	slog.Info("browser started", "bin", bin, "pid", cmd.Process.Pid)

	c := &chrome{cmd: cmd, done: make(chan struct{})}
	go func() {
		err := cmd.Wait()
		_ = outR.Close()
		close(c.done)
		slog.Info("browser exited", "err", err)
	}()
	c.conn = newConn(cmdW, outR, onEvent, onExit)

	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var ver struct {
		UserAgent string `json:"userAgent"`
	}
	if err := c.conn.call(ctx, "", "Browser.getVersion", nil, &ver); err != nil {
		c.kill()
		return nil, fmt.Errorf("browser didn't start: %w", err)
	}
	c.userAgent = strings.Replace(ver.UserAgent, "HeadlessChrome", "Chrome", 1)
	if err := c.conn.call(ctx, "", "Target.setDiscoverTargets", map[string]any{"discover": true}, nil); err != nil {
		c.kill()
		return nil, err
	}
	return c, nil
}

// close asks the browser to quit, then kills it if it hasn't within a few
// seconds.
func (c *chrome) close() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	_ = c.conn.call(ctx, "", "Browser.close", nil, nil)
	cancel()
	select {
	case <-c.done:
	case <-time.After(3 * time.Second):
		c.kill()
	}
	c.conn.close()
}

func (c *chrome) kill() {
	_ = c.cmd.Process.Kill()
	c.conn.close()
}
