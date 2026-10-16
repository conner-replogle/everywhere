package claude

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/proc"
	"github.com/conner-replogle/everywhere/daemon/internal/term"
)

// TokenEnv is the variable claude reads a long-lived token from, in place
// of the credentials it signs in with and renews.
const TokenEnv = "CLAUDE_CODE_OAUTH_TOKEN"

// TokenLogin is a `claude setup-token` waiting for the code from its
// sign-in page: like Login, but what it ends with is a token that lasts a
// year and is never renewed, so claude processes can't sign each other out
// renewing it at once.
//
// setup-token is a full-screen terminal program, so it runs on a pseudo
// terminal: wide enough that nothing wraps, its sign-in URL is read from the
// hyperlink it prints and the token from the text it shows at the end.
type TokenLogin struct {
	// URL is the sign-in page.
	URL string

	tty      term.TTY
	group    *proc.Group
	done     chan struct{}
	err      error
	canceled atomic.Bool

	mu    sync.Mutex
	out   []byte // what it printed, escape sequences and all (the end of it)
	token string
	// submitted: a code was typed; after is what it printed since, where a
	// refusal shows up. refused is that refusal.
	submitted bool
	after     []byte
	refused   string

	writeMu sync.Mutex // the reader answers terminal queries while Submit types
}

// How setup-token's output is read: the URL is in an OSC 8 hyperlink, and
// the token is plain text once escape sequences are removed.
var (
	hyperlinkURL = regexp.MustCompile(`\x1b\]8;[^;\x07\x1b]*;(https://[^\x07\x1b]+)`)
	// Where a console drops hyperlinks (Windows' may), the URL is still
	// shown in full: the terminal is wide enough for it.
	shownURL   = regexp.MustCompile(`https://\S*oauth/authorize\?\S+`)
	oauthToken = regexp.MustCompile(`sk-ant-oat01-[A-Za-z0-9_-]{20,}`)
	escapes    = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_^][^\x1b]*\x1b\\|\x1b[@-Z\\-_]`)
	// Moving the cursor right is how the screen shows spaces.
	cursorRight = regexp.MustCompile(`\x1b\[(\d*)C`)
	// A refused code: "OAuth error: … Press Enter to retry." It then waits.
	oauthError = regexp.MustCompile(`OAuth error:[^\r\n]*`)
)

// What a terminal answers when asked, as the full-screen UI asks on start
// (and may wait for, as on Windows): its identity, its kind, where the
// cursor is. Kitty's keyboard query (CSI ? u) gets no answer, which with the
// kind's answer says it isn't supported.
var terminalAnswers = []struct {
	query  *regexp.Regexp
	answer string
}{
	{regexp.MustCompile(`\x1b\[>0?q`), "\x1bP>|xterm(everywhere)\x1b\\"},
	{regexp.MustCompile(`\x1b\[0?c`), "\x1b[?62;22c"},
	{regexp.MustCompile(`\x1b\[6n`), "\x1b[1;1R"},
	{regexp.MustCompile(`\x1b\]10;\?(?:\x07|\x1b\\)`), "\x1b]10;rgb:ffff/ffff/ffff\x1b\\"},
	{regexp.MustCompile(`\x1b\]11;\?(?:\x07|\x1b\\)`), "\x1b]11;rgb:0000/0000/0000\x1b\\"},
}

// tokenOutputMax bounds the output kept to find the URL and token in.
const tokenOutputMax = 256 << 10

// StartTokenLogin starts `claude setup-token` and returns once it has
// printed its sign-in URL. ctx bounds only that wait; Cancel ends it.
func StartTokenLogin(ctx context.Context, bin string, env []string) (*TokenLogin, error) {
	env = loginEnv(env)
	// A token already in the environment would be what it reports on.
	env = slicesDeleteEnv(env, TokenEnv)
	home, _ := os.UserHomeDir()
	tty, group, err := term.Spawn(term.Command{Dir: home, Args: []string{bin, "setup-token"}, Env: env, Cols: 1000, Rows: 50})
	if err != nil {
		return nil, fmt.Errorf("claude: start %s setup-token: %w", bin, err)
	}
	l := &TokenLogin{tty: tty, group: group, done: make(chan struct{})}

	found := make(chan string, 1)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		buf := make([]byte, 32<<10)
		for {
			n, err := tty.Read(buf)
			if n > 0 {
				if u := l.take(buf[:n]); u != "" {
					select {
					case found <- u:
					default:
					}
				}
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		code := tty.Wait()
		group.Release()
		_ = tty.Close()
		<-readerDone
		l.mu.Lock()
		token := l.token
		l.mu.Unlock()
		l.mu.Lock()
		refused := l.refused
		l.mu.Unlock()
		switch {
		case token != "":
		case refused != "":
			l.err = fmt.Errorf("claude setup-token: %s", refused)
		case l.canceled.Load():
			l.err = ErrLoginCanceled
		default:
			l.err = l.failure(code)
		}
		close(l.done)
	}()

	select {
	case l.URL = <-found:
		return l, nil
	case <-l.done:
		if l.err == nil {
			return nil, errors.New("claude setup-token finished without a sign-in link")
		}
		return nil, l.err
	case <-ctx.Done():
		l.Cancel()
		return nil, fmt.Errorf("claude setup-token didn't give a sign-in link: %w", ctx.Err())
	}
}

// take keeps a chunk of output and returns the sign-in URL once it's seen.
// Once the token appears, setup-token has nothing left to do; it's ended
// shortly after if it hasn't ended itself.
func (l *TokenLogin) take(chunk []byte) string {
	for _, a := range terminalAnswers {
		for range a.query.FindAll(chunk, -1) {
			_ = l.write(a.answer)
		}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.out = append(l.out, chunk...)
	if l.submitted && l.refused == "" && l.token == "" {
		l.after = append(l.after, chunk...)
		if len(l.after) > tokenOutputMax {
			l.after = l.after[len(l.after)-tokenOutputMax:]
		}
		if m := oauthError.FindString(plainText(l.after)); m != "" && oauthToken.FindString(plainText(l.after)) == "" {
			// It waits for Enter to try again; this sign-in is over instead.
			l.refused = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(m), "Press Enter to retry."))
			go func() { _ = l.group.Signal(syscall.SIGKILL) }()
		}
	}
	if len(l.out) > tokenOutputMax {
		l.out = l.out[len(l.out)-tokenOutputMax:]
	}
	var url string
	text := plainText(l.out)
	if m := hyperlinkURL.FindSubmatch(l.out); m != nil && strings.Contains(string(m[1]), "oauth") {
		url = string(m[1])
	} else if u := shownURL.FindString(text); u != "" {
		url = u
	}
	if l.token == "" {
		if t := oauthToken.FindString(text); t != "" {
			l.token = t
			time.AfterFunc(2*time.Second, func() {
				select {
				case <-l.done:
				default:
					_ = l.group.Signal(syscall.SIGKILL)
				}
			})
		}
	}
	return url
}

// plainText is terminal output without its escape sequences, the spaces
// it drew by moving the cursor put back.
func plainText(b []byte) string {
	s := cursorRight.ReplaceAllStringFunc(string(b), func(m string) string {
		n := 1
		if d := cursorRight.FindStringSubmatch(m)[1]; d != "" {
			fmt.Sscan(d, &n)
		}
		return strings.Repeat(" ", min(n, 200))
	})
	return escapes.ReplaceAllString(s, "")
}

// write types into setup-token's terminal.
func (l *TokenLogin) write(s string) error {
	l.writeMu.Lock()
	defer l.writeMu.Unlock()
	_, err := io.WriteString(l.tty, s)
	return err
}

// Submit types the code from the sign-in page and waits for the token. An
// error means it was refused; the login is over either way.
func (l *TokenLogin) Submit(ctx context.Context, code string) error {
	code = strings.TrimSpace(code)
	if code == "" {
		return errors.New("paste the code from the sign-in page")
	}
	l.mu.Lock()
	l.submitted = true
	l.mu.Unlock()
	if err := l.write(code + "\r"); err != nil {
		select {
		case <-l.done:
			return l.Err()
		default:
		}
		return fmt.Errorf("claude setup-token: %w", err)
	}
	select {
	case <-l.done:
		return l.Err()
	case <-ctx.Done():
		l.Cancel()
		return ctx.Err()
	}
}

// Token is the token, once Done is closed with no error.
func (l *TokenLogin) Token() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.token
}

// Done is closed once setup-token has ended; Err then says whether it gave a token.
func (l *TokenLogin) Done() <-chan struct{} { return l.done }

// Err is why it failed, once Done is closed.
func (l *TokenLogin) Err() error {
	select {
	case <-l.done:
		return l.err
	default:
		return nil
	}
}

// Cancel ends it.
func (l *TokenLogin) Cancel() {
	l.canceled.Store(true)
	select {
	case <-l.done:
	default:
		_ = l.group.Signal(syscall.SIGKILL)
	}
}

// failure explains an exit without a token from the last thing it showed.
func (l *TokenLogin) failure(code int) error {
	l.mu.Lock()
	text := plainText(l.out)
	l.mu.Unlock()
	var last string
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r", "\n"), "\n") {
		if line = strings.TrimSpace(line); line != "" && !strings.Contains(line, "https://") {
			last = line
		}
	}
	if last == "" {
		return fmt.Errorf("claude setup-token exited (%d) without a token", code)
	}
	return fmt.Errorf("claude setup-token: %s", last)
}

// slicesDeleteEnv is env without key; nil stays nil-free (the daemon's
// environment, copied).
func slicesDeleteEnv(env []string, key string) []string {
	if env == nil {
		env = os.Environ()
	}
	out := make([]string, 0, len(env))
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		if runtime.GOOS == "windows" {
			if strings.EqualFold(k, key) {
				continue
			}
		} else if k == key {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// WithToken is env (nil: the daemon's) with claude's long-lived token, or
// without one when token is "".
func WithToken(env []string, token string) []string {
	env = slicesDeleteEnv(env, TokenEnv)
	if token != "" {
		env = append(env, TokenEnv+"="+token)
	}
	return env
}
