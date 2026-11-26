package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/claude"
	"github.com/conner-replogle/everywhere/daemon/internal/harness"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// Other agents' sign-ins (harness.Agent.Login), from wherever the user is,
// as claude's are (auth.go): the agent's sign-in command prints a link whose
// page ends on a code, which comes back with FinishHarnessLogin.

// harnessLogin is another agent's sign-in in progress.
type harnessLogin struct {
	*claude.Login
	agent   harness.Agent
	settled chan struct{}
}

func knownAgent(kind string) (harness.Agent, error) {
	a, ok := harness.ByKind(kind)
	if !ok {
		return harness.Agent{}, fmt.Errorf("no agent %q here", kind)
	}
	return a, nil
}

// HarnessAuth reports whether another agent is signed in, by asking it.
func (m *Manager) HarnessAuth(ctx context.Context, kind string) (protocol.HarnessAuth, error) {
	a, err := knownAgent(kind)
	if err != nil {
		return protocol.HarnessAuth{}, err
	}
	m.mu.Lock()
	signingIn := m.harnessLogins[kind] != nil
	m.mu.Unlock()
	st := protocol.HarnessAuth{Kind: a.Kind, Title: a.Title, CanSignIn: len(a.Login) > 0, SigningIn: signingIn}
	if _, err := exec.LookPath(a.Command[0]); err != nil {
		return st, nil
	}
	st.Installed = true
	dir := filepath.Join(m.agentDir, "probe", a.Kind)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return st, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	st.SignedIn, st.Known, err = harness.Auth(ctx, a, dir)
	if err != nil {
		st.Problem = err.Error()
	}
	return st, nil
}

// StartHarnessLogin starts signing another agent in and returns its sign-in
// page, whose code goes to FinishHarnessLogin. It replaces one waiting.
func (m *Manager) StartHarnessLogin(ctx context.Context, kind string) (protocol.ClaudeLogin, error) {
	a, err := knownAgent(kind)
	if err != nil {
		return protocol.ClaudeLogin{}, err
	}
	if len(a.Login) == 0 {
		return protocol.ClaudeLogin{}, fmt.Errorf("%s can't be signed in from here", a.Title)
	}
	if _, err := exec.LookPath(a.Login[0]); err != nil {
		return protocol.ClaudeLogin{}, fmt.Errorf("%s isn't installed here. %s", a.Title, a.Install)
	}
	m.CancelHarnessLogin(kind)
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	l, err := claude.StartLoginCommand(ctx, a.Login, m.noBrowserEnv(), a.LoginPrompt)
	if err != nil {
		return protocol.ClaudeLogin{}, err
	}
	p := &harnessLogin{Login: l, agent: a, settled: make(chan struct{})}
	m.mu.Lock()
	if m.harnessLogins == nil {
		m.harnessLogins = map[string]*harnessLogin{}
	}
	m.harnessLogins[kind] = p
	m.mu.Unlock()
	go m.awaitHarnessLogin(p)
	m.authChanged()
	return protocol.ClaudeLogin{URL: l.URL}, nil
}

// awaitHarnessLogin sees a sign-in through: to the end, or to its timeout.
func (m *Manager) awaitHarnessLogin(p *harnessLogin) {
	defer close(p.settled)
	select {
	case <-p.Done():
	case <-time.After(loginTimeout):
		p.Cancel()
	}
	m.mu.Lock()
	if m.harnessLogins[p.agent.Kind] == p {
		delete(m.harnessLogins, p.agent.Kind)
	}
	m.mu.Unlock()
	if err := p.Err(); err != nil {
		if !errors.Is(err, claude.ErrLoginCanceled) {
			slog.Warn("agent sign-in failed", "kind", p.agent.Kind, "err", err)
		}
	} else {
		slog.Info("agent signed in", "kind", p.agent.Kind)
		go m.probeAgent(p.agent) // what it offers may only now be learnable
	}
	m.authChanged()
}

// FinishHarnessLogin gives the agent's waiting sign-in the code from its
// page, and reports how it went.
func (m *Manager) FinishHarnessLogin(ctx context.Context, kind, code string) (protocol.HarnessAuth, error) {
	m.mu.Lock()
	p := m.harnessLogins[kind]
	m.mu.Unlock()
	if p == nil {
		return protocol.HarnessAuth{}, errors.New("this sign-in ended; start again")
	}
	sctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	if err := p.Submit(sctx, code); err != nil {
		return protocol.HarnessAuth{}, err
	}
	<-p.settled
	return m.HarnessAuth(ctx, kind)
}

// noBrowserEnv is the environment for an agent's sign-in, which mustn't
// open its page on this device: whoever signs in may be on another, and
// opens it there. Some (agy) run xdg-open or open themselves, whatever
// BROWSER says, so those are stand-ins that do nothing, ahead on PATH.
// Windows has none, so a browser may open there.
func (m *Manager) noBrowserEnv() []string {
	env := os.Environ()
	if runtime.GOOS == "windows" {
		return env
	}
	dir := filepath.Join(m.agentDir, "no-browser")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		slog.Warn("agent sign-in: no stand-in browser", "err", err)
		return env
	}
	for _, name := range []string{"xdg-open", "open", "sensible-browser", "x-www-browser"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
			slog.Warn("agent sign-in: no stand-in browser", "err", err)
			return env
		}
	}
	for i, kv := range env {
		if strings.HasPrefix(kv, "PATH=") {
			env[i] = "PATH=" + dir + string(os.PathListSeparator) + kv[len("PATH="):]
			return env
		}
	}
	return append(env, "PATH="+dir)
}

// CancelHarnessLogin ends an agent's sign-in that's waiting for its code.
func (m *Manager) CancelHarnessLogin(kind string) {
	m.mu.Lock()
	p := m.harnessLogins[kind]
	delete(m.harnessLogins, kind)
	m.mu.Unlock()
	if p != nil {
		p.Cancel()
	}
}
