package claude

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"

	"github.com/conner-replogle/everywhere/daemon/internal/proc"
)

// AuthStatus is what `claude auth status` reports.
type AuthStatus struct {
	LoggedIn bool `json:"loggedIn"`
	// AuthMethod is claude.ai, console, an API key's source, or none.
	AuthMethod       string `json:"authMethod"`
	APIProvider      string `json:"apiProvider"`
	Email            string `json:"email,omitempty"`
	OrgName          string `json:"orgName,omitempty"`
	SubscriptionType string `json:"subscriptionType,omitempty"`
}

// Auth asks the CLI whether it's signed in. It only looks at the stored
// credentials, so revoked ones still count as signed in until a request
// fails with authentication_failed.
func Auth(ctx context.Context, bin string, env []string) (AuthStatus, error) {
	cmd := exec.CommandContext(ctx, bin, "auth", "status", "--json")
	cmd.Env = env
	// Signed out exits 1, with the status on stdout all the same.
	out, runErr := cmd.Output()
	var st AuthStatus
	if err := json.Unmarshal(out, &st); err != nil {
		if runErr != nil {
			return AuthStatus{}, fmt.Errorf("claude auth status: %w", runErr)
		}
		return AuthStatus{}, fmt.Errorf("claude auth status: %w", err)
	}
	return st, nil
}

// Login is a `claude auth login` waiting for the code from its sign-in page.
//
// The CLI prints a URL whose redirect is Anthropic's own page, which shows a
// code to paste back rather than calling back to localhost, so it can be
// opened on any device. The code goes to the CLI's stdin.
type Login struct {
	// URL is the sign-in page.
	URL string

	cmd      *exec.Cmd
	group    *proc.Group
	stdin    io.WriteCloser
	out      *tailBuffer
	done     chan struct{}
	err      error
	canceled atomic.Bool
}

// ErrLoginCanceled is a login's error after Cancel.
var ErrLoginCanceled = errors.New("the sign-in was canceled")

// StartLogin starts signing in, with a Claude subscription or, with console,
// an Anthropic Console account (API billing). It returns once the CLI has
// printed the sign-in URL. ctx bounds only that wait; Cancel ends the login.
func StartLogin(ctx context.Context, bin string, env []string, console bool) (*Login, error) {
	method := "--claudeai"
	if console {
		method = "--console"
	}
	cmd := exec.Command(bin, "auth", "login", method)
	cmd.Env = loginEnv(env)
	cmd.Dir, _ = os.UserHomeDir()
	l := &Login{cmd: cmd, out: &tailBuffer{max: stderrTail}, done: make(chan struct{})}
	cmd.Stderr = l.out
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if l.stdin, err = cmd.StdinPipe(); err != nil {
		return nil, err
	}
	if l.group, err = proc.Start(cmd); err != nil {
		return nil, fmt.Errorf("claude: start %s auth login: %w", bin, err)
	}

	found := make(chan string, 1)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		r := bufio.NewReader(io.TeeReader(stdout, l.out))
		for {
			line, err := r.ReadString('\n')
			if u := loginURL(line); u != "" {
				select {
				case found <- u:
				default:
				}
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		<-readerDone
		err := cmd.Wait()
		l.group.Release()
		switch {
		case l.canceled.Load():
			l.err = ErrLoginCanceled
		case err != nil:
			l.err = l.failure(err)
		}
		close(l.done)
	}()

	select {
	case l.URL = <-found:
		return l, nil
	case <-l.done:
		if l.err == nil {
			// Signed in without a code, e.g. with an API key in the environment.
			return l, nil
		}
		return nil, l.err
	case <-ctx.Done():
		l.Cancel()
		return nil, fmt.Errorf("claude auth login didn't give a sign-in link: %w", ctx.Err())
	}
}

// loginEnv keeps the CLI from opening a browser on this machine: whoever
// signs in may be on another device, and opens the link there. Windows has
// no stand-in command, so a browser may open there.
func loginEnv(env []string) []string {
	if env == nil {
		env = os.Environ()
	}
	if runtime.GOOS == "windows" {
		return env
	}
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if !strings.HasPrefix(kv, "BROWSER=") {
			out = append(out, kv)
		}
	}
	return append(out, "BROWSER=true")
}

// loginURL finds the sign-in URL in a line of the CLI's output: "If the
// browser didn't open, visit: https://…".
func loginURL(line string) string {
	for f := range strings.FieldsSeq(line) {
		if strings.HasPrefix(f, "https://") && strings.Contains(f, "oauth") {
			return f
		}
	}
	return ""
}

// Submit gives the CLI the code from the sign-in page and waits for it to
// finish signing in. An error means the code was refused; the login is over
// either way.
func (l *Login) Submit(ctx context.Context, code string) error {
	code = strings.TrimSpace(code)
	if code == "" {
		return errors.New("paste the code from the sign-in page")
	}
	if _, err := io.WriteString(l.stdin, code+"\n"); err != nil {
		select {
		case <-l.done:
			return l.Err()
		default:
		}
		return fmt.Errorf("claude auth login: %w", err)
	}
	select {
	case <-l.done:
		return l.Err()
	case <-ctx.Done():
		l.Cancel()
		return ctx.Err()
	}
}

// Done is closed once the CLI has exited; Err then says whether it signed in.
func (l *Login) Done() <-chan struct{} { return l.done }

// Err is why the login failed, once Done is closed.
func (l *Login) Err() error {
	select {
	case <-l.done:
		return l.err
	default:
		return nil
	}
}

// Cancel ends the login, if it's still running, and waits for it to exit.
func (l *Login) Cancel() {
	select {
	case <-l.done:
		return
	default:
	}
	l.canceled.Store(true)
	_ = l.stdin.Close()
	_ = l.group.Signal(syscall.SIGKILL)
	<-l.done
}

// failure is a failed login's error: the CLI's own words after its paste
// prompt, e.g. "Login failed: Request failed with status code 400".
func (l *Login) failure(err error) error {
	out := l.out.String()
	if _, after, ok := strings.Cut(out, "Paste code here if prompted >"); ok {
		out = after
	} else if l.URL != "" {
		out = "" // only the sign-in link so far
	}
	if text := strings.TrimSpace(out); text != "" {
		return errors.New(lastN(text, 500))
	}
	return fmt.Errorf("claude auth login: %w", err)
}
