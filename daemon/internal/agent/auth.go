package agent

import (
	"context"
	"errors"
	"log/slog"
	"maps"
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
	st, err := claude.Auth(ctx, bin, env)
	if err != nil {
		return protocol.ClaudeAuth{}, err
	}
	m.mu.Lock()
	problem, signingIn := m.authProblem, m.login != nil
	m.mu.Unlock()
	return protocol.ClaudeAuth{
		SignedIn:     st.LoggedIn && problem == "",
		Method:       st.AuthMethod,
		Email:        st.Email,
		Org:          st.OrgName,
		Subscription: st.SubscriptionType,
		Problem:      problem,
		SigningIn:    signingIn,
	}, nil
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
// code goes to FinishLogin. It replaces a sign-in already waiting.
func (m *Manager) StartLogin(ctx context.Context, console bool) (protocol.ClaudeLogin, error) {
	bin, env, err := m.claudeBinary(ctx)
	if err != nil {
		return protocol.ClaudeLogin{}, err
	}
	m.CancelLogin()
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	l, err := claude.StartLogin(ctx, bin, env, console)
	if err != nil {
		return protocol.ClaudeLogin{}, err
	}
	p := &pendingLogin{Login: l, settled: make(chan struct{})}
	m.mu.Lock()
	m.login = p
	m.mu.Unlock()
	go m.awaitLogin(p)
	m.authChanged()
	return protocol.ClaudeLogin{URL: l.URL}, nil
}

// pendingLogin is a sign-in in progress. settled is closed once its outcome
// has been acted on.
type pendingLogin struct {
	*claude.Login
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
