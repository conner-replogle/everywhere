package browser

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg" // DecodeConfig of screenshots
	_ "image/png"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// This file is the tab's automation surface for agents: the operations the
// MCP browser tools are made of. They call CDP directly rather than going
// through the input queue, because agents need each step's result.

const (
	maxEvalResult  = 64 << 10
	maxVisibleText = 20000
	maxElements    = 200
	evalWait       = 30 * time.Second
	settleWait     = 5 * time.Second
	pollEvery      = 100 * time.Millisecond
)

// automationJS defines, next to elementJS's helpers:
//   - __ewTarget(spec, scroll): finds one element by {selector} or {text},
//     optionally scrolls it into view ("center" | "nearest"), and returns its
//     centre, a brief description and what covers that point, if anything
//     else; or {error}. The element is kept in __ewLast.
//   - __ewSnapshot(maxText, maxEls): the page's text and visible elements.
//   - __ewCheck({selector, text, url}): which of those conditions hold.
//   - __ewActive(): the focused element, looking inside shadow roots.
const automationJS = `(() => {
  if (window.__ewTarget) return;
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],' +
    '[role=menuitem],[role=checkbox],[role=radio],[role=option],[role=switch],[role=combobox],[role=textbox],' +
    '[role=searchbox],[role=slider],[onclick],[tabindex]:not([tabindex="-1"]),[contenteditable=""],[contenteditable=true]';
  const NOTABLE = INTERACTIVE + ',h1,h2,h3,h4,h5,h6,img[alt],[role=dialog],[role=alert],[role=heading],label';
  const deepAll = (sel) => {
    const out = [];
    const visit = (root) => {
      out.push(...root.querySelectorAll(sel));
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(document);
    return out;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    return el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
  };
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const texts = (el) => {
    const a = [el.getAttribute('aria-label'), el.labels && el.labels[0] && el.labels[0].innerText,
      el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('alt')];
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/.test(el.type)) a.push(el.value);
    a.push(el.innerText);
    return a.map(norm).filter(Boolean);
  };
  const brief = (el) => {
    const d = __ewDescribe(el);
    return { tag: d.tag, role: d.role, name: d.name, selector: d.selector };
  };
  const byText = (q) => {
    q = norm(q);
    const ql = q.toLowerCase();
    const els = deepAll('*').filter((el) => !/^(HTML|HEAD|BODY|SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName) && visible(el));
    const tiers = [(t) => t === q, (t) => t.toLowerCase() === ql, (t) => t.toLowerCase().includes(ql)];
    // Interactive elements in any tier beat others: "Save" should find the
    // button before a heading that says the same.
    for (const interactive of [true, false]) {
      for (const tier of tiers) {
        let m = els.filter((el) => (!interactive || el.matches(INTERACTIVE)) && texts(el).some(tier));
        if (!m.length) continue;
        return m.filter((el) => !m.some((o) => o !== el && el.contains(o))); // innermost
      }
    }
    return [];
  };
  const find = (spec) => {
    let m;
    if (spec.selector) {
      try { m = deepAll(spec.selector); } catch (e) { return { error: 'invalid selector ' + JSON.stringify(spec.selector) + ': ' + e.message }; }
      if (!m.length) return { error: 'no element matches selector ' + JSON.stringify(spec.selector) };
      const vis = m.filter(visible);
      if (!vis.length) return { error: 'selector ' + JSON.stringify(spec.selector) + ' matches ' + m.length + ' element(s), none of them visible' };
      m = vis;
    } else {
      m = byText(spec.text || '');
      if (!m.length) return { error: 'no visible element has text ' + JSON.stringify(spec.text) };
    }
    if (m.length > 1) {
      return { error: (spec.selector ? 'selector ' + JSON.stringify(spec.selector) : 'text ' + JSON.stringify(spec.text)) +
        ' matches ' + m.length + ' visible elements; be more specific. First matches: ' +
        m.slice(0, 5).map((el) => { const b = brief(el); return b.selector + (b.name ? ' (' + JSON.stringify(b.name) + ')' : ''); }).join(', ') };
    }
    return { el: m[0] };
  };
  window.__ewActive = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };
  window.__ewTarget = (spec, scroll) => {
    const r = find(spec);
    if (r.error) return r;
    const el = r.el;
    if (scroll) el.scrollIntoView({ block: scroll, inline: scroll, behavior: 'instant' });
    const b = el.getBoundingClientRect();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    const hit = __ewDeepAt(x, y);
    window.__ewLast = el;
    return {
      x, y, element: brief(el),
      covered: hit && hit !== el && !el.contains(hit) && !hit.contains(el) ? __ewSelector(hit) : undefined,
      inViewport: x >= 0 && y >= 0 && x < innerWidth && y < innerHeight,
    };
  };
  window.__ewSnapshot = (maxText, maxEls) => {
    const text = document.body ? document.body.innerText : '';
    const found = [];
    for (const el of deepAll(NOTABLE)) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      found.push({ el, r, inView: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth });
    }
    found.sort((a, b) => (b.inView - a.inView));
    const elements = found.slice(0, maxEls).map(({ el, r, inView }) => {
      const e = brief(el);
      e.x = Math.round(r.x); e.y = Math.round(r.y); e.width = Math.round(r.width); e.height = Math.round(r.height);
      if (!inView) e.offscreen = true;
      if ('value' in el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'password' && el.value) e.value = String(el.value).slice(0, 200);
      if (el.type === 'checkbox' || el.type === 'radio') e.checked = el.checked;
      if (el.disabled) e.disabled = true;
      if (el.tagName === 'A' && el.href) e.href = el.href;
      return e;
    });
    const a = __ewActive();
    return {
      url: location.href, title: document.title, readyState: document.readyState,
      text: text.length > maxText ? text.slice(0, maxText) : text, textTruncated: text.length > maxText,
      elements, elementCount: found.length,
      focused: a && a !== document.body && a !== document.documentElement ? __ewSelector(a) : undefined,
      viewport: { width: innerWidth, height: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY),
        pageWidth: document.documentElement.scrollWidth, pageHeight: document.documentElement.scrollHeight },
    };
  };
  window.__ewCheck = (c) => {
    const out = {};
    if (c.selector) {
      try { out.selector = deepAll(c.selector).some(visible); } catch (e) { return { error: 'invalid selector: ' + e.message }; }
    }
    if (c.text) out.text = !!document.body && document.body.innerText.includes(c.text);
    if (c.url) out.url = location.href.includes(c.url);
    return out;
  };
})()`

// do sends a CDP command on the tab's session, giving up after wait or when
// ctx or the tab ends.
func (t *Tab) do(ctx context.Context, wait time.Duration, method string, params, out any) error {
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	stop := context.AfterFunc(t.ctx, cancel)
	defer stop()
	err := t.br.conn.call(ctx, t.sessionID, method, params, out)
	if err != nil && t.ctx.Err() != nil {
		return errors.New("the browser tab closed")
	}
	return err
}

// evalError is a script that threw.
type evalError struct{ msg string }

func (e *evalError) Error() string { return e.msg }

type remoteValue struct {
	Type                string          `json:"type"`
	Value               json.RawMessage `json:"value"`
	UnserializableValue string          `json:"unserializableValue"`
	Description         string          `json:"description"`
}

// evaluate runs expr in the page and returns its value by JSON. repl
// evaluates it like the DevTools console does, allowing top-level await.
func (t *Tab) evaluate(ctx context.Context, wait time.Duration, expr string, await, repl bool) (remoteValue, error) {
	var r struct {
		Result           remoteValue `json:"result"`
		ExceptionDetails *struct {
			Text      string       `json:"text"`
			Exception *remoteValue `json:"exception"`
		} `json:"exceptionDetails"`
	}
	err := t.do(ctx, wait, "Runtime.evaluate", map[string]any{
		"expression":    expr,
		"returnByValue": true,
		"awaitPromise":  await,
		"userGesture":   true,
		"replMode":      repl,
	}, &r)
	if err != nil {
		return remoteValue{}, err
	}
	if e := r.ExceptionDetails; e != nil {
		msg := e.Text
		if e.Exception != nil && e.Exception.Description != "" {
			msg = e.Exception.Description
		}
		return remoteValue{}, &evalError{msg}
	}
	return r.Result, nil
}

// pageJSON runs expr with the element helpers installed and decodes its
// value into out.
func (t *Tab) pageJSON(ctx context.Context, expr string, out any) error {
	v, err := t.evaluate(ctx, callWait, elementJS+";\n"+automationJS+";\n"+expr, true, false)
	if err != nil {
		return err
	}
	if out == nil || len(v.Value) == 0 {
		return nil
	}
	return json.Unmarshal(v.Value, out)
}

func jsArgs(args ...any) string {
	parts := make([]string, len(args))
	for i, a := range args {
		b, _ := json.Marshal(a)
		parts[i] = string(b)
	}
	return strings.Join(parts, ", ")
}

// State returns the tab's state and whether anyone is watching it.
func (t *Tab) State() (protocol.BrowserState, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.state, len(t.viewers) > 0
}

// agent shows viewers what the agent is doing.
func (t *Tab) agent(action string, x, y float64, label string) {
	t.broadcast(protocol.BrowserAgent{T: "agent", Action: action, X: x, Y: y, Label: clipText(label, 80)})
}

// NavigateURL resolves where to navigate: rawURL, or a port on this
// machine plus path. A URL without a scheme gets http for loopback hosts
// and https otherwise.
func NavigateURL(rawURL string, port int, path string) (string, error) {
	if port != 0 {
		if port < 1 || port > 65535 {
			return "", fmt.Errorf("port %d is out of range", port)
		}
		if path != "" && !strings.HasPrefix(path, "/") {
			path = "/" + path
		}
		return checkURL("http://localhost:" + strconv.Itoa(port) + path)
	}
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return "", errors.New("give a url or a port")
	}
	if rawURL != "about:blank" && !strings.Contains(rawURL, "://") {
		host := rawURL
		if i := strings.IndexAny(host, "/?#"); i >= 0 {
			host = host[:i]
		}
		scheme := "https://"
		if u, err := url.Parse("http://" + host); err == nil && isLoopback(u.Hostname()) {
			scheme = "http://"
		}
		rawURL = scheme + rawURL
	}
	return checkURL(rawURL)
}

func isLoopback(host string) bool {
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || host == "0.0.0.0" {
		return true
	}
	h := strings.Trim(host, "[]")
	return strings.HasPrefix(h, "127.") || h == "::1"
}

// Navigate loads u and waits for readiness: "load" (the default),
// "domContentLoaded" or "none". It gives up waiting after timeout, which
// isn't an error: the page may just be slow.
func (t *Tab) Navigate(ctx context.Context, u, readiness string, timeout time.Duration) (ready bool, err error) {
	defer func() { t.diag.act("navigate", u, err) }()
	t.agent("navigate", 0, 0, u)
	var r struct {
		LoaderID  string `json:"loaderId"`
		ErrorText string `json:"errorText"`
	}
	if err := t.do(ctx, callWait, "Page.navigate", map[string]any{"url": u}, &r); err != nil {
		return false, err
	}
	if r.ErrorText != "" {
		return false, fmt.Errorf("couldn't load %s: %s", u, r.ErrorText)
	}
	if r.LoaderID == "" || readiness == "none" { // same-document navigation, or no wait
		return true, nil
	}
	want := `document.readyState === "complete"`
	if readiness == "domContentLoaded" {
		want = `document.readyState !== "loading"`
	}
	return t.poll(ctx, timeout, func() (bool, error) {
		v, err := t.evaluate(ctx, callWait, want, false, false)
		if err != nil {
			return false, nil // the new document may not have a context yet
		}
		return string(v.Value) == "true", nil
	})
}

// poll calls check until it says done, errs, or timeout passes; timing out
// returns false without an error.
func (t *Tab) poll(ctx context.Context, timeout time.Duration, check func() (bool, error)) (bool, error) {
	deadline := time.Now().Add(timeout)
	for {
		ok, err := check()
		if ok || err != nil {
			return ok, err
		}
		if !time.Now().Before(deadline) {
			return false, nil
		}
		select {
		case <-time.After(pollEvery):
		case <-ctx.Done():
			return false, ctx.Err()
		case <-t.ctx.Done():
			return false, errors.New("the browser tab closed")
		}
	}
}

// SetViewport sizes the tab as the viewer's viewport picker does and waits
// for it to apply.
func (t *Tab) SetViewport(ctx context.Context, mode, preset, orientation string, width, height int) (setting protocol.BrowserViewportSetting, err error) {
	defer func() {
		t.diag.act("resize", fmt.Sprintf("%s %s %s %dx%d", mode, preset, orientation, width, height), err)
	}()
	want, err := ResolveViewport(mode, preset, orientation, width, height)
	if err != nil {
		return want, err
	}
	t.agent("resize", 0, 0, want.Mode+" "+want.Preset)
	t.enqueue(nil, protocol.BrowserClientMsg{T: "viewport", Mode: mode, Preset: preset, Orientation: orientation, Width: width, Height: height})
	ok, err := t.poll(ctx, settleWait, func() (bool, error) {
		st, _ := t.State()
		setting = st.Viewport
		if want.Mode == "fill" {
			return setting.Mode == "fill", nil
		}
		return setting == want, nil
	})
	if err == nil && !ok {
		err = errors.New("the viewport didn't change in time")
	}
	return setting, err
}

// SetColorScheme emulates prefers-color-scheme: light, dark, or "" for the
// system's.
func (t *Tab) SetColorScheme(ctx context.Context, scheme string) (err error) {
	defer func() { t.diag.act("appearance", scheme, err) }()
	if scheme != "" && scheme != "light" && scheme != "dark" {
		return fmt.Errorf("unknown color scheme %q", scheme)
	}
	t.agent("appearance", 0, 0, scheme)
	t.enqueue(nil, protocol.BrowserClientMsg{T: "appearance", ColorScheme: scheme})
	ok, err := t.poll(ctx, settleWait, func() (bool, error) {
		st, _ := t.State()
		return st.ColorScheme == scheme, nil
	})
	if err == nil && !ok {
		err = errors.New("the color scheme didn't change in time")
	}
	return err
}

// PageElement is an element as a snapshot lists it.
type PageElement struct {
	Tag       string  `json:"tag"`
	Role      string  `json:"role,omitempty"`
	Name      string  `json:"name,omitempty"`
	Selector  string  `json:"selector"`
	X         float64 `json:"x"`
	Y         float64 `json:"y"`
	Width     float64 `json:"width"`
	Height    float64 `json:"height"`
	Offscreen bool    `json:"offscreen,omitempty"`
	Value     string  `json:"value,omitempty"`
	Checked   *bool   `json:"checked,omitempty"`
	Disabled  bool    `json:"disabled,omitempty"`
	Href      string  `json:"href,omitempty"`
}

// PageSnapshot is what an agent reads before acting on a page.
type PageSnapshot struct {
	URL           string        `json:"url"`
	Title         string        `json:"title"`
	ReadyState    string        `json:"readyState"`
	Loading       bool          `json:"loading"`
	Text          string        `json:"text"`
	TextTruncated bool          `json:"textTruncated,omitempty"`
	Elements      []PageElement `json:"elements"`
	ElementCount  int           `json:"elementCount"`
	Focused       string        `json:"focused,omitempty"`
	Viewport      struct {
		Width      int `json:"width"`
		Height     int `json:"height"`
		ScrollX    int `json:"scrollX"`
		ScrollY    int `json:"scrollY"`
		PageWidth  int `json:"pageWidth"`
		PageHeight int `json:"pageHeight"`
	} `json:"viewport"`
	Console  []ConsoleEntry `json:"console"`
	Network  []NetworkEntry `json:"failedRequests"`
	Actions  []ActionEntry  `json:"recentActions"`
	Warnings []string       `json:"warnings,omitempty"`
}

// Snapshot describes the page: its text, visible elements, and recent
// console messages, failed requests and agent actions (up to recent each).
func (t *Tab) Snapshot(ctx context.Context, recent int) (*PageSnapshot, error) {
	var s PageSnapshot
	if err := t.pageJSON(ctx, "__ewSnapshot("+jsArgs(maxVisibleText, maxElements)+")", &s); err != nil {
		return nil, err
	}
	if s.Elements == nil {
		s.Elements = []PageElement{}
	}
	st, _ := t.State()
	s.Loading = st.Loading
	s.Console, s.Network, s.Actions = t.Diagnostics(recent)
	return &s, nil
}

// Screenshot captures the viewport as "jpeg" or "png", scaled down so its
// longest side is at most maxSide pixels (0 for the page's own resolution).
func (t *Tab) Screenshot(ctx context.Context, format string, maxSide int) (data []byte, width, height int, err error) {
	var lm struct {
		Viewport struct {
			PageX        float64 `json:"pageX"`
			PageY        float64 `json:"pageY"`
			ClientWidth  float64 `json:"clientWidth"`
			ClientHeight float64 `json:"clientHeight"`
		} `json:"cssVisualViewport"`
	}
	if err := t.do(ctx, callWait, "Page.getLayoutMetrics", nil, &lm); err != nil {
		return nil, 0, 0, err
	}
	vp := lm.Viewport
	if vp.ClientWidth <= 0 || vp.ClientHeight <= 0 {
		return nil, 0, 0, errors.New("the page has no size")
	}
	dpr := 1.0
	if v, err := t.evaluate(ctx, callWait, "devicePixelRatio", false, false); err == nil {
		if f, err := strconv.ParseFloat(string(v.Value), 64); err == nil && f > 0 {
			dpr = f
		}
	}
	scale := 1.0
	if long := math.Max(vp.ClientWidth, vp.ClientHeight) * dpr; maxSide > 0 && long > float64(maxSide) {
		scale = float64(maxSide) / long
	}
	params := map[string]any{
		"format": format,
		"clip": map[string]any{
			"x": vp.PageX, "y": vp.PageY, "width": vp.ClientWidth, "height": vp.ClientHeight, "scale": scale,
		},
	}
	if format == "jpeg" {
		params["quality"] = 80
	}
	var r struct {
		Data []byte `json:"data"`
	}
	if err := t.do(ctx, callWait, "Page.captureScreenshot", params, &r); err != nil {
		return nil, 0, 0, err
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(r.Data))
	if err != nil {
		return nil, 0, 0, fmt.Errorf("reading screenshot: %w", err)
	}
	return r.Data, cfg.Width, cfg.Height, nil
}

// SaveScreenshot writes a full-resolution PNG of the viewport under the
// browser's data directory and returns its path.
func (t *Tab) SaveScreenshot(ctx context.Context) (string, error) {
	data, _, _, err := t.Screenshot(ctx, "png", 0)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(t.m.dir, "artifacts")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	suffix := make([]byte, 4)
	_, _ = rand.Read(suffix)
	path := filepath.Join(dir, "screenshot-"+time.Now().Format("20060102-150405")+"-"+hex.EncodeToString(suffix)+".png")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", err
	}
	return filepath.Abs(path)
}

// Target picks an element by CSS selector or visible text, or a point.
type Target struct {
	Selector string
	Text     string
	X, Y     *float64
}

func (tg Target) String() string {
	switch {
	case tg.Selector != "":
		return "selector " + tg.Selector
	case tg.Text != "":
		return "text " + strconv.Quote(tg.Text)
	case tg.X != nil && tg.Y != nil:
		return fmt.Sprintf("point %g,%g", *tg.X, *tg.Y)
	}
	return "nothing"
}

// Hit is where an action landed.
type Hit struct {
	X       float64      `json:"x"`
	Y       float64      `json:"y"`
	Element *PageElement `json:"element,omitempty"`
	// Covered is the selector of whatever is on top of the element at X/Y,
	// which then gets the click instead.
	Covered string `json:"covered,omitempty"`
}

// locate resolves a target to a point, scrolling an element into view as
// scroll says ("center", "nearest" or "").
func (t *Tab) locate(ctx context.Context, tg Target, scroll string) (*Hit, error) {
	if tg.X != nil || tg.Y != nil {
		if tg.X == nil || tg.Y == nil {
			return nil, errors.New("give both x and y")
		}
		h := &Hit{X: *tg.X, Y: *tg.Y}
		var el *protocol.BrowserElement
		if err := t.pageJSON(ctx, fmt.Sprintf(`(() => { const el = __ewDeepAt(%g, %g); window.__ewLast = el; return el ? __ewDescribe(el) : null; })()`, h.X, h.Y), &el); err == nil && el != nil {
			h.Element = &PageElement{Tag: el.Tag, Role: el.Role, Name: el.Name, Selector: el.Selector, X: el.X, Y: el.Y, Width: el.Width, Height: el.Height}
		}
		return h, nil
	}
	if tg.Selector == "" && tg.Text == "" {
		return nil, errors.New("give a selector, text, or x and y")
	}
	spec := map[string]string{"selector": tg.Selector, "text": tg.Text}
	var r struct {
		Error      string       `json:"error"`
		X          float64      `json:"x"`
		Y          float64      `json:"y"`
		Element    *PageElement `json:"element"`
		Covered    string       `json:"covered"`
		InViewport bool         `json:"inViewport"`
	}
	var sc any = scroll
	if scroll == "" {
		sc = false
	}
	if err := t.pageJSON(ctx, "__ewTarget("+jsArgs(spec, sc)+")", &r); err != nil {
		return nil, err
	}
	if r.Error != "" {
		return nil, errors.New(r.Error)
	}
	if !r.InViewport {
		return nil, fmt.Errorf("%s is outside the viewport even after scrolling", tg)
	}
	return &Hit{X: r.X, Y: r.Y, Element: r.Element, Covered: r.Covered}, nil
}

var buttonMask = map[string]int{"left": 1, "right": 2, "middle": 4}

// Click clicks the target's centre with button (left, right or middle)
// count times in a row (2 for a double click).
func (t *Tab) Click(ctx context.Context, tg Target, button string, count int) (h *Hit, err error) {
	defer func() { t.diag.act("click", tg.String(), err) }()
	if button == "" {
		button = "left"
	}
	mask, ok := buttonMask[button]
	if !ok {
		return nil, fmt.Errorf("unknown button %q", button)
	}
	count = min(max(count, 1), 3)
	if h, err = t.locate(ctx, tg, "center"); err != nil {
		return nil, err
	}
	label := tg.String()
	if h.Element != nil && h.Element.Name != "" {
		label = h.Element.Name
	}
	t.agent("click", h.X, h.Y, label)
	if err := t.mouse(ctx, "mouseMoved", h.X, h.Y, "none", 0, 0); err != nil {
		return nil, err
	}
	for i := 1; i <= count; i++ {
		if err := t.mouse(ctx, "mousePressed", h.X, h.Y, button, mask, i); err != nil {
			return nil, err
		}
		if err := t.mouse(ctx, "mouseReleased", h.X, h.Y, button, 0, i); err != nil {
			return nil, err
		}
	}
	return h, nil
}

func (t *Tab) mouse(ctx context.Context, typ string, x, y float64, button string, buttons, clicks int) error {
	p := map[string]any{"type": typ, "x": x, "y": y, "button": button, "buttons": buttons, "pointerType": "mouse"}
	if clicks > 0 {
		p["clickCount"] = clicks
	}
	return t.do(ctx, callWait, "Input.dispatchMouseEvent", p, nil)
}

// Type focuses the target (by clicking it) if there is one, optionally
// clears it, inserts text, and optionally presses Enter.
func (t *Tab) Type(ctx context.Context, tg *Target, text string, clear, submit bool) (h *Hit, err error) {
	detail := strconv.Quote(clipText(text, 60))
	if tg != nil {
		detail += " into " + tg.String()
	}
	defer func() { t.diag.act("type", detail, err) }()
	if tg != nil {
		if h, err = t.locate(ctx, *tg, "center"); err != nil {
			return nil, err
		}
		t.agent("type", h.X, h.Y, text)
		if err := t.mouse(ctx, "mouseMoved", h.X, h.Y, "none", 0, 0); err != nil {
			return nil, err
		}
		if err := t.mouse(ctx, "mousePressed", h.X, h.Y, "left", 1, 1); err != nil {
			return nil, err
		}
		if err := t.mouse(ctx, "mouseReleased", h.X, h.Y, "left", 0, 1); err != nil {
			return nil, err
		}
		// A click on a label or a covered field may not focus it.
		if err := t.pageJSON(ctx, `(() => { const el = window.__ewLast, a = __ewActive();
			if (el && a !== el && !el.contains(a) && el.focus) el.focus(); })()`, nil); err != nil {
			return nil, err
		}
	} else {
		t.agent("type", 0, 0, text)
	}
	var focused bool
	if err := t.pageJSON(ctx, `(() => { const a = __ewActive(); return !!a && a !== document.body && a !== document.documentElement; })()`, &focused); err != nil {
		return nil, err
	}
	if !focused {
		return nil, errors.New("nothing on the page has focus; give a selector or target to type into")
	}
	if clear {
		if err := t.pageJSON(ctx, `(() => { const a = __ewActive();
			if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.select) a.select(); else document.execCommand('selectAll'); })()`, nil); err != nil {
			return nil, err
		}
		if err := t.pressKey(ctx, "Backspace", 0); err != nil {
			return nil, err
		}
	}
	if text != "" {
		if err := t.do(ctx, callWait, "Input.insertText", map[string]any{"text": text}, nil); err != nil {
			return nil, err
		}
	}
	if submit {
		if err := t.pressKey(ctx, "Enter", 0); err != nil {
			return nil, err
		}
	}
	return h, nil
}

// Modifier bits, as CDP (and protocol.BrowserClientMsg) take them.
var modifierBits = map[string]int{"Alt": 1, "Control": 2, "Meta": 4, "Shift": 8}

// Press presses key with modifiers held. key may also be a combination
// like "Control+a".
func (t *Tab) Press(ctx context.Context, key string, modifiers []string) (err error) {
	defer func() { t.diag.act("press", strings.Join(append(modifiers, key), "+"), err) }()
	mods := 0
	for _, m := range modifiers {
		bit, ok := modifierBits[m]
		if !ok {
			return fmt.Errorf("unknown modifier %q (Alt, Control, Meta or Shift)", m)
		}
		mods |= bit
	}
	if len(key) > 1 && strings.Contains(key, "+") && !strings.HasSuffix(key, "++") {
		parts := strings.Split(key, "+")
		key = parts[len(parts)-1]
		for _, m := range parts[:len(parts)-1] {
			bit, ok := modifierBits[normalizeModifier(m)]
			if !ok {
				return fmt.Errorf("unknown modifier %q in %q", m, strings.Join(parts, "+"))
			}
			mods |= bit
		}
	}
	t.agent("press", 0, 0, key)
	return t.pressKey(ctx, key, mods)
}

func normalizeModifier(m string) string {
	switch strings.ToLower(m) {
	case "ctrl", "control":
		return "Control"
	case "cmd", "command", "meta", "super":
		return "Meta"
	case "alt", "option":
		return "Alt"
	case "shift":
		return "Shift"
	}
	return m
}

// pressKey sends a key down and up.
func (t *Tab) pressKey(ctx context.Context, key string, mods int) error {
	k, err := lookupKey(key, mods&8 != 0)
	if err != nil {
		return err
	}
	down := map[string]any{
		"type": "rawKeyDown", "modifiers": mods, "key": k.key, "code": k.code,
		"windowsVirtualKeyCode": k.keyCode, "nativeVirtualKeyCode": k.keyCode, "location": k.location,
	}
	// Text makes it a character key; not with Control, Alt or Meta held,
	// which make it a shortcut.
	if k.text != "" && mods&(1|2|4) == 0 {
		down["type"], down["text"], down["unmodifiedText"] = "keyDown", k.text, k.text
	}
	if err := t.do(ctx, callWait, "Input.dispatchKeyEvent", down, nil); err != nil {
		return err
	}
	return t.do(ctx, callWait, "Input.dispatchKeyEvent", map[string]any{
		"type": "keyUp", "modifiers": mods, "key": k.key, "code": k.code,
		"windowsVirtualKeyCode": k.keyCode, "nativeVirtualKeyCode": k.keyCode, "location": k.location,
	}, nil)
}

type keyDef struct {
	key, code, text string
	keyCode         int
	location        int
}

var namedKeys = map[string]keyDef{
	"Enter":      {"Enter", "Enter", "\r", 13, 0},
	"Tab":        {"Tab", "Tab", "", 9, 0},
	"Escape":     {"Escape", "Escape", "", 27, 0},
	"Backspace":  {"Backspace", "Backspace", "", 8, 0},
	"Delete":     {"Delete", "Delete", "", 46, 0},
	"Insert":     {"Insert", "Insert", "", 45, 0},
	"ArrowLeft":  {"ArrowLeft", "ArrowLeft", "", 37, 0},
	"ArrowUp":    {"ArrowUp", "ArrowUp", "", 38, 0},
	"ArrowRight": {"ArrowRight", "ArrowRight", "", 39, 0},
	"ArrowDown":  {"ArrowDown", "ArrowDown", "", 40, 0},
	"Home":       {"Home", "Home", "", 36, 0},
	"End":        {"End", "End", "", 35, 0},
	"PageUp":     {"PageUp", "PageUp", "", 33, 0},
	"PageDown":   {"PageDown", "PageDown", "", 34, 0},
	" ":          {" ", "Space", " ", 32, 0},
	"Shift":      {"Shift", "ShiftLeft", "", 16, 1},
	"Control":    {"Control", "ControlLeft", "", 17, 1},
	"Alt":        {"Alt", "AltLeft", "", 18, 1},
	"Meta":       {"Meta", "MetaLeft", "", 91, 1},
	"-":          {"-", "Minus", "-", 189, 0},
	"=":          {"=", "Equal", "=", 187, 0},
	",":          {",", "Comma", ",", 188, 0},
	".":          {".", "Period", ".", 190, 0},
	"/":          {"/", "Slash", "/", 191, 0},
	";":          {";", "Semicolon", ";", 186, 0},
	"'":          {"'", "Quote", "'", 222, 0},
	"[":          {"[", "BracketLeft", "[", 219, 0},
	"]":          {"]", "BracketRight", "]", 221, 0},
	`\`:          {`\`, "Backslash", `\`, 220, 0},
	"`":          {"`", "Backquote", "`", 192, 0},
}

var keyAliases = map[string]string{
	"return": "Enter", "esc": "Escape", "space": " ", "spacebar": " ", "del": "Delete",
	"left": "ArrowLeft", "right": "ArrowRight", "up": "ArrowUp", "down": "ArrowDown",
	"pgup": "PageUp", "pgdn": "PageDown", "ctrl": "Control", "cmd": "Meta", "option": "Alt",
}

// lookupKey describes key as DOM KeyboardEvent key, code and legacy
// keyCode, with its text when it types one.
func lookupKey(key string, shift bool) (keyDef, error) {
	if k, ok := namedKeys[key]; ok {
		return k, nil
	}
	lower := strings.ToLower(key)
	if a, ok := keyAliases[lower]; ok {
		return namedKeys[a], nil
	}
	for name, k := range namedKeys {
		if strings.ToLower(name) == lower && len(name) > 1 {
			return k, nil
		}
	}
	if len(key) >= 2 && (key[0] == 'F' || key[0] == 'f') {
		if n, err := strconv.Atoi(key[1:]); err == nil && n >= 1 && n <= 24 {
			f := "F" + strconv.Itoa(n)
			return keyDef{key: f, code: f, keyCode: 111 + n}, nil
		}
	}
	if r := []rune(key); len(r) == 1 {
		c := r[0]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z':
			up := strings.ToUpper(key)
			text := key
			if shift {
				text = up
			}
			return keyDef{key: text, code: "Key" + up, text: text, keyCode: int(up[0])}, nil
		case c >= '0' && c <= '9':
			return keyDef{key: key, code: "Digit" + key, text: key, keyCode: int(c)}, nil
		}
		return keyDef{key: key, text: key}, nil // other characters: text only
	}
	return keyDef{}, fmt.Errorf("unknown key %q", key)
}

// ScrollResult is the scroll position before and after a scroll.
type ScrollResult struct {
	Before ScrollPos `json:"before"`
	After  ScrollPos `json:"after"`
	// Target is the element the wheel turned over, if one was given.
	Target string `json:"target,omitempty"`
}

type ScrollPos struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// Scroll turns the mouse wheel over the target, or the middle of the
// viewport, and reports how far the page (or the target) scrolled.
func (t *Tab) Scroll(ctx context.Context, tg *Target, dx, dy float64) (res ScrollResult, err error) {
	detail := fmt.Sprintf("%g,%g", dx, dy)
	if tg != nil {
		detail += " over " + tg.String()
	}
	defer func() { t.diag.act("scroll", detail, err) }()
	var x, y float64
	if tg != nil {
		h, err := t.locate(ctx, *tg, "nearest")
		if err != nil {
			return res, err
		}
		x, y = h.X, h.Y
		if h.Element != nil {
			res.Target = h.Element.Selector
		}
	} else {
		var size struct{ W, H float64 }
		if err := t.pageJSON(ctx, `({W: innerWidth, H: innerHeight})`, &size); err != nil {
			return res, err
		}
		x, y = size.W/2, size.H/2
		_ = t.pageJSON(ctx, `window.__ewLast = null`, nil)
	}
	// Where scrolling shows: the target's nearest scrollable ancestor, or
	// the page.
	const where = `(() => {
		let el = window.__ewLast;
		for (; el && el !== document.documentElement; el = el.parentElement) {
			const cs = getComputedStyle(el);
			if (/(auto|scroll|overlay)/.test(cs.overflowY + cs.overflowX) && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) break;
		}
		return el && el !== document.documentElement ? {X: Math.round(el.scrollLeft), Y: Math.round(el.scrollTop)} : {X: Math.round(scrollX), Y: Math.round(scrollY)};
	})()`
	_ = t.pageJSON(ctx, where, &res.Before)
	t.agent("scroll", x, y, fmt.Sprintf("%g,%g", dx, dy))
	if err := t.do(ctx, callWait, "Input.dispatchMouseEvent", map[string]any{
		"type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy, "pointerType": "mouse",
	}, nil); err != nil {
		return res, err
	}
	// Wheel scrolling can be animated; wait for it to settle a little.
	last, still := res.Before, 0
	_, _ = t.poll(ctx, time.Second, func() (bool, error) {
		_ = t.pageJSON(ctx, where, &res.After)
		if res.After == last {
			still++
		} else {
			last, still = res.After, 0
		}
		return still >= 3, nil
	})
	return res, nil
}

// Evaluate runs a JavaScript expression in the page and returns its value
// as JSON, up to maxEvalResult bytes.
func (t *Tab) Evaluate(ctx context.Context, expr string, await bool) (value json.RawMessage, err error) {
	defer func() { t.diag.act("evaluate", expr, err) }()
	v, err := t.evaluate(ctx, evalWait, expr, await, await)
	if err != nil {
		return nil, err
	}
	switch {
	case v.UnserializableValue != "":
		value, _ = json.Marshal(v.UnserializableValue)
	case len(v.Value) > 0:
		value = v.Value
	default:
		value = json.RawMessage("null") // undefined, or not serializable
	}
	if len(value) > maxEvalResult {
		return nil, fmt.Errorf("the result is %d bytes of JSON, over the %d KB limit; return less", len(value), maxEvalResult>>10)
	}
	return value, nil
}

// WaitCond is what WaitFor waits for; every given condition must hold.
type WaitCond struct {
	Selector    string `json:"selector,omitempty"` // a visible element matches
	Text        string `json:"text,omitempty"`     // the page's visible text contains it
	URLIncludes string `json:"url,omitempty"`
}

// WaitFor polls until every condition holds, up to timeout.
func (t *Tab) WaitFor(ctx context.Context, c WaitCond, timeout time.Duration) (err error) {
	b, _ := json.Marshal(c)
	defer func() { t.diag.act("wait_for", string(b), err) }()
	if c == (WaitCond{}) {
		return errors.New("give a selector, text or urlIncludes to wait for")
	}
	var last map[string]bool
	ok, err := t.poll(ctx, timeout, func() (bool, error) {
		var r struct {
			Error    string `json:"error"`
			Selector *bool  `json:"selector"`
			Text     *bool  `json:"text"`
			URL      *bool  `json:"url"`
		}
		if err := t.pageJSON(ctx, "__ewCheck("+string(b)+")", &r); err != nil {
			var ee *evalError
			if errors.As(err, &ee) {
				return false, err
			}
			return false, nil // mid-navigation
		}
		if r.Error != "" {
			return false, errors.New(r.Error)
		}
		last = map[string]bool{}
		all := true
		for name, v := range map[string]*bool{"selector": r.Selector, "text": r.Text, "urlIncludes": r.URL} {
			if v != nil {
				last[name] = *v
				all = all && *v
			}
		}
		return all, nil
	})
	if err != nil || ok {
		return err
	}
	var failing []string
	for name, v := range last {
		if !v {
			failing = append(failing, name)
		}
	}
	slices.Sort(failing)
	if len(failing) == 0 {
		return fmt.Errorf("timed out after %s waiting for the page", timeout)
	}
	return fmt.Errorf("timed out after %s; still not matching: %s", timeout, strings.Join(failing, ", "))
}
