package agent

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/claude"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// Claude Code's sign-in: noticing when its credentials stop working, and
// signing it in again from wherever the user is.

// How long a sign-in waits for its code before giving up.
const loginTimeout = 15 * time.Minute

// authFailed is the assistant error claude reports when the API refused its
// credentials, or it has none.
const authFailed = "authentication_failed"

// Claude Code renews its OAuth token under a lock shared by every claude on
// the machine. One that finds another renewing it (or a stale lock from one
// killed mid-renewal) fails its request with authentication_failed, though
// the credentials are fine. Such a turn is retried, after a growing wait, up
// to maxRefreshRetries times before it counts as signed out.
const maxRefreshRetries = 3

// refreshContended reports whether claude's complaint is losing that race.
func refreshContended(text string) bool {
	return strings.Contains(text, "another Claude Code process is refreshing")
}

// signInProblem is claude's complaint about its credentials without its
// advice to run /login, which only its own terminal UI offers.
func signInProblem(text string) string {
	text = strings.TrimSpace(text)
	for _, sep := range []string{" · ", " - "} {
		if before, after, ok := strings.Cut(text, sep); ok && strings.Contains(after, "/login") {
			text = before
		}
	}
	return text
}

// ClaudeAuth reports whether claude is signed in.
func (m *Manager) ClaudeAuth(ctx context.Context) (protocol.ClaudeAuth, error) {
	bin, env, err := m.claudeBinary(ctx)
	if err != nil {
		return protocol.ClaudeAuth{}, err
	}
	tok, _ := m.loadToken()
	st, err := claude.Auth(ctx, bin, claude.WithToken(env, tok.Token))
	if err != nil {
		return protocol.ClaudeAuth{}, err
	}
	m.mu.Lock()
	problem, signingIn := m.authProblem, m.login != nil
	m.mu.Unlock()
	a := protocol.ClaudeAuth{
		SignedIn:     st.LoggedIn && problem == "",
		Method:       st.AuthMethod,
		Email:        st.Email,
		Org:          st.OrgName,
		Subscription: st.SubscriptionType,
		Problem:      problem,
		SigningIn:    signingIn,
	}
	if tok.Token != "" {
		expires := tok.ExpiresAt
		a.TokenExpiresAt = &expires
	}
	return a, nil
}

// tokenLife is how long a setup-token token lasts.
const tokenLife = 365 * 24 * time.Hour

// storedToken is claude's long-lived token, kept in the daemon's data
// directory and given to every claude it starts.
type storedToken struct {
	Token     string `json:"token"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
}

// loadToken reads the stored token; none is no error.
func (m *Manager) loadToken() (storedToken, error) {
	var t storedToken
	raw, err := os.ReadFile(m.tokenPath)
	if errors.Is(err, os.ErrNotExist) {
		return t, nil
	}
	if err != nil {
		return t, err
	}
	err = json.Unmarshal(raw, &t)
	return t, err
}

// saveToken keeps a new token, or with "" forgets the one kept.
func (m *Manager) saveToken(token string) error {
	if token == "" {
		if err := os.Remove(m.tokenPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	now := time.Now()
	raw, _ := json.Marshal(storedToken{Token: token, CreatedAt: now.UnixMilli(), ExpiresAt: now.Add(tokenLife).UnixMilli()})
	if err := os.MkdirAll(filepath.Dir(m.tokenPath), 0o700); err != nil {
		return err
	}
	tmp := m.tokenPath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, m.tokenPath)
}

// withToken is env with the stored long-lived token, if there is one, so
// claude uses it rather than renewing its own credentials.
func (m *Manager) withToken(env []string) []string {
	t, err := m.loadToken()
	if err != nil {
		slog.Warn("claude token unreadable; using claude's own sign-in", "err", err)
	}
	if t.Token == "" {
		return env
	}
	return claude.WithToken(env, t.Token)
}

// noteAuthFailed records that a request was refused for claude's
// credentials. It reports whether that's news.
func (m *Manager) noteAuthFailed(text string) bool {
	if text == "" {
		text = "Claude Code isn't signed in"
	}
	m.mu.Lock()
	news := m.authProblem == ""
	m.authProblem = text
	m.mu.Unlock()
	if news {
		slog.Warn("claude isn't signed in", "said", text)
		m.authChanged()
	}
	return news
}

// noteAuthWorked clears a recorded sign-in problem after a turn got through.
func (m *Manager) noteAuthWorked() {
	m.mu.Lock()
	had := m.authProblem != ""
	m.authProblem = ""
	m.mu.Unlock()
	if had {
		m.authChanged()
	}
}

func (m *Manager) authChanged() {
	if m.AuthChanged != nil {
		go m.AuthChanged()
	}
}

// authGeneration counts sign-ins; a process started before the latest one
// makes way for one with the new credentials when idle.
func (m *Manager) authGeneration() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.authGen
}

// StartLogin starts signing claude in and returns the sign-in page, whose
// code goes to FinishLogin. It replaces a sign-in already waiting. A
// longLived sign-in (claude setup-token) gets a token that lasts a year and
// is never renewed, which every claude the daemon starts then uses; a
// regular one goes back to claude's own, renewed credentials.
func (m *Manager) StartLogin(ctx context.Context, console, longLived bool) (protocol.ClaudeLogin, error) {
	bin, env, err := m.claudeBinary(ctx)
	if err != nil {
		return protocol.ClaudeLogin{}, err
	}
	m.CancelLogin()
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	var p *pendingLogin
	var url string
	if longLived {
		l, err := claude.StartTokenLogin(ctx, bin, env)
		if err != nil {
			return protocol.ClaudeLogin{}, err
		}
		p, url = &pendingLogin{signIn: l, token: l.Token, settled: make(chan struct{})}, l.URL
	} else {
		l, err := claude.StartLogin(ctx, bin, env, console)
		if err != nil {
			return protocol.ClaudeLogin{}, err
		}
		p, url = &pendingLogin{signIn: l, settled: make(chan struct{})}, l.URL
	}
	m.mu.Lock()
	m.login = p
	m.mu.Unlock()
	go m.awaitLogin(p)
	m.authChanged()
	return protocol.ClaudeLogin{URL: url}, nil
}

// signIn is a claude sign-in waiting for its code: claude.Login or
// claude.TokenLogin.
type signIn interface {
	Submit(ctx context.Context, code string) error
	Done() <-chan struct{}
	Err() error
	Cancel()
}

// pendingLogin is a sign-in in progress. token, for a long-lived sign-in,
// gives its token once done. settled is closed once its outcome has been
// acted on.
type pendingLogin struct {
	signIn
	token   func() string
	settled chan struct{}
}

// awaitLogin sees a sign-in through: to the end, or to its timeout.
func (m *Manager) awaitLogin(p *pendingLogin) {
	defer close(p.settled)
	select {
	case <-p.Done():
	case <-time.After(loginTimeout):
		p.Cancel()
	}
	m.mu.Lock()
	current := m.login == p
	if current {
		m.login = nil
	}
	m.mu.Unlock()
	if err := p.Err(); err != nil {
		if current {
			m.authChanged()
		}
		return
	}
	// A long-lived sign-in's token is what claude uses from now on; a
	// regular sign-in drops a token kept from before, so its credentials are.
	var token string
	if p.token != nil {
		token = p.token()
	}
	if err := m.saveToken(token); err != nil {
		slog.Error("keeping claude's sign-in", "err", err)
	}
	m.signedIn()
}

// FinishLogin gives the waiting sign-in the code from its page.
func (m *Manager) FinishLogin(ctx context.Context, code string) (protocol.ClaudeAuth, error) {
	m.mu.Lock()
	p := m.login
	m.mu.Unlock()
	if p == nil {
		return protocol.ClaudeAuth{}, errors.New("this sign-in ended; start again")
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	if err := p.Submit(ctx, code); err != nil {
		return protocol.ClaudeAuth{}, err
	}
	<-p.settled
	return m.ClaudeAuth(ctx)
}

// CancelLogin ends a sign-in that's waiting for its code.
func (m *Manager) CancelLogin() {
	m.mu.Lock()
	p := m.login
	m.login = nil
	m.mu.Unlock()
	if p != nil {
		p.Cancel()
		m.authChanged()
	}
}

// signedIn runs once claude has new credentials. Threads' claude processes
// make way for ones that use them when next idle (see session.changed), and
// the account they report is learned again.
func (m *Manager) signedIn() {
	m.mu.Lock()
	m.authProblem = ""
	m.authGen++
	m.infoAt = time.Time{}
	sessions := slices.Collect(maps.Values(m.sessions))
	m.mu.Unlock()
	slog.Info("claude signed in")
	for _, s := range sessions {
		s.do(s.changed)
	}
	m.authChanged()
}
