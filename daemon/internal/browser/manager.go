// Package browser runs a headless Chromium on the device and streams its tabs
// to clients as JPEG screencasts, feeding their mouse and keyboard back in
// over the DevTools protocol. The page runs next to the dev servers it shows,
// so localhost, hot reload and cookies behave as they would locally.
package browser

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"path/filepath"
	"sync"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// The browser quits after this long with nobody watching any tab.
const idleTimeout = 10 * time.Minute

// Client is one viewer of a tab.
type Client interface {
	// Frame sends one screencast frame; only one goroutine per tab calls it.
	Frame(hdr protocol.BrowserFrame, jpeg []byte)
	// Send sends a JSON message.
	Send(msg any)
	// Buffered is how many bytes are queued to the client, for flow control.
	Buffered() uint64
	// Closed says the tab is gone; the client should close its channel.
	Closed(reason string)
}

// Manager owns the browser process and one tab per key (a project id).
type Manager struct {
	dir string

	mu       sync.Mutex
	chrome   *chrome
	tabs     map[string]*Tab
	lastURL  map[string]string // by key, so a relaunched browser reopens pages
	idle     *time.Timer
	shutdown bool

	// Event routing, read on the CDP reader goroutine; never held across calls.
	routeMu   sync.Mutex
	bySession map[string]*Tab
	byTarget  map[string]*Tab
}

// NewManager keeps the browser profile (cookies, storage) under dir.
func NewManager(dir string) *Manager {
	return &Manager{
		dir:       dir,
		tabs:      map[string]*Tab{},
		lastURL:   map[string]string{},
		bySession: map[string]*Tab{},
		byTarget:  map[string]*Tab{},
	}
}

// Attach adds a viewer to key's tab, starting the browser and the tab as
// needed. The viewer's viewport becomes the tab's.
func (m *Manager) Attach(ctx context.Context, key string, c Client, vp Viewport) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, err := m.tabLocked(ctx, key)
	if err != nil {
		return err
	}
	t.attach(c, vp)
	return nil
}

// Use returns key's tab for an agent to drive, starting the browser and the
// tab as needed. Each use postpones closing an unwatched browser.
func (m *Manager) Use(ctx context.Context, key string) (*Tab, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, err := m.tabLocked(ctx, key)
	if err != nil {
		return nil, err
	}
	for _, other := range m.tabs {
		if other.watched() {
			return t, nil
		}
	}
	m.idle = time.AfterFunc(idleTimeout, m.idleClose)
	return t, nil
}

// tabLocked returns key's tab, starting the browser and the tab as needed,
// and stops the idle timer.
func (m *Manager) tabLocked(ctx context.Context, key string) (*Tab, error) {
	if m.shutdown {
		return nil, errors.New("shutting down")
	}
	if m.idle != nil {
		m.idle.Stop()
		m.idle = nil
	}
	if m.chrome == nil {
		var br *chrome
		br, err := launchChrome(ctx, filepath.Join(m.dir, "profile"), m.route, func(error) { m.exited(br) })
		if err != nil {
			return nil, err
		}
		m.chrome = br
	}
	t := m.tabs[key]
	if t == nil {
		var err error
		if t, err = m.openTab(ctx, key); err != nil {
			return nil, err
		}
		m.tabs[key] = t
	}
	return t, nil
}

// Detach removes a viewer; the browser quits once nobody has watched for a while.
func (m *Manager) Detach(key string, c Client) {
	m.mu.Lock()
	t := m.tabs[key]
	m.mu.Unlock()
	if t != nil {
		t.detach(c)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.chrome == nil || m.idle != nil {
		return
	}
	for _, t := range m.tabs {
		if t.watched() {
			return
		}
	}
	m.idle = time.AfterFunc(idleTimeout, m.idleClose)
}

// Handle applies one message from an attached viewer.
func (m *Manager) Handle(key string, c Client, msg protocol.BrowserClientMsg) {
	m.mu.Lock()
	t := m.tabs[key]
	m.mu.Unlock()
	if t != nil {
		t.enqueue(c, msg)
	}
}

// Shutdown closes the browser.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	m.shutdown = true
	br, tabs := m.takeLocked()
	m.mu.Unlock()
	for _, t := range tabs {
		t.shut("The device is shutting down")
	}
	if br != nil {
		br.close()
	}
}

func (m *Manager) idleClose() {
	m.mu.Lock()
	for _, t := range m.tabs {
		if t.watched() {
			m.mu.Unlock()
			return
		}
	}
	m.idle = nil
	br, tabs := m.takeLocked()
	m.mu.Unlock()
	for _, t := range tabs {
		t.shut("")
	}
	if br != nil {
		slog.Info("closing idle browser")
		br.close()
	}
}

// exited handles the browser going away on its own.
func (m *Manager) exited(br *chrome) {
	m.mu.Lock()
	if br == nil || m.chrome != br {
		m.mu.Unlock()
		return
	}
	_, tabs := m.takeLocked()
	m.mu.Unlock()
	slog.Warn("browser exited unexpectedly")
	for _, t := range tabs {
		t.shut("The browser exited")
	}
}

// takeLocked detaches the browser and its tabs from the manager, remembering
// each tab's page.
func (m *Manager) takeLocked() (*chrome, []*Tab) {
	br := m.chrome
	m.chrome = nil
	tabs := make([]*Tab, 0, len(m.tabs))
	for key, t := range m.tabs {
		if u := t.url(); u != "" {
			m.lastURL[key] = u
		}
		tabs = append(tabs, t)
	}
	m.tabs = map[string]*Tab{}
	m.routeMu.Lock()
	m.bySession = map[string]*Tab{}
	m.byTarget = map[string]*Tab{}
	m.routeMu.Unlock()
	return br, tabs
}

func (m *Manager) openTab(ctx context.Context, key string) (*Tab, error) {
	br := m.chrome
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var created struct {
		TargetID string `json:"targetId"`
	}
	// A window per tab, so no tab is ever in the background.
	if err := br.conn.call(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank", "newWindow": true}, &created); err != nil {
		return nil, err
	}
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := br.conn.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": created.TargetID, "flatten": true}, &attached); err != nil {
		return nil, err
	}
	t := newTab(m, key, br, created.TargetID, attached.SessionID)
	m.routeMu.Lock()
	m.bySession[t.sessionID] = t
	m.byTarget[t.targetID] = t
	m.routeMu.Unlock()
	if err := t.setup(ctx); err != nil {
		m.unroute(t)
		t.shut("")
		_ = br.conn.call(ctx, "", "Target.closeTarget", map[string]any{"targetId": t.targetID}, nil)
		return nil, err
	}
	go t.run()
	t.enqueue(nil, protocol.BrowserClientMsg{T: "apply"})
	if u := m.lastURL[key]; u != "" && u != "about:blank" {
		t.enqueue(nil, protocol.BrowserClientMsg{T: "navigate", URL: u})
	}
	return t, nil
}

func (m *Manager) unroute(t *Tab) {
	m.routeMu.Lock()
	defer m.routeMu.Unlock()
	for id, rt := range m.bySession {
		if rt == t {
			delete(m.bySession, id)
		}
	}
	for id, rt := range m.byTarget {
		if rt == t {
			delete(m.byTarget, id)
		}
	}
}

// watchTarget routes a popup's target events to the tab that opened it.
func (m *Manager) watchTarget(targetID string, t *Tab) {
	m.routeMu.Lock()
	m.byTarget[targetID] = t
	m.routeMu.Unlock()
}

func (m *Manager) unwatchTarget(targetID string) {
	m.routeMu.Lock()
	delete(m.byTarget, targetID)
	m.routeMu.Unlock()
}

// tabGone drops a tab whose page closed itself.
func (m *Manager) tabGone(t *Tab) {
	m.mu.Lock()
	if m.tabs[t.key] == t {
		delete(m.tabs, t.key)
	}
	m.mu.Unlock()
	m.unroute(t)
	t.shut("The page was closed")
}

// route runs on the CDP reader goroutine: it must only queue.
func (m *Manager) route(sessionID, method string, params json.RawMessage) {
	if sessionID != "" {
		m.routeMu.Lock()
		t := m.bySession[sessionID]
		m.routeMu.Unlock()
		if t != nil {
			t.events.push(event{method, params})
		}
		return
	}
	var p struct {
		TargetInfo targetInfo `json:"targetInfo"`
		TargetID   string     `json:"targetId"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	id := p.TargetInfo.TargetID
	if id == "" {
		id = p.TargetID
	}
	if method == "Target.targetCreated" {
		id = p.TargetInfo.OpenerID // a popup belongs to its opener
	}
	if id == "" {
		return
	}
	m.routeMu.Lock()
	t := m.byTarget[id]
	m.routeMu.Unlock()
	if t != nil {
		t.events.push(event{method, params})
	}
}

type targetInfo struct {
	TargetID string `json:"targetId"`
	Type     string `json:"type"`
	URL      string `json:"url"`
	Title    string `json:"title"`
	OpenerID string `json:"openerId"`
}
