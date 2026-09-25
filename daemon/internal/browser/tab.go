package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

const (
	// A viewer with more than this queued skips frames until it drains, and
	// the next frame waits (up to drainWait) for every viewer to get below it.
	lowWater  = 512 << 10
	drainWait = 250 * time.Millisecond
	callWait  = 10 * time.Second

	pageBinding = "__everywhere"
)

// pageScript runs in every document the tab loads and reports, through
// pageBinding, what the screencast can't carry: the CSS cursor under the
// pointer ("c:<cursor>") and the title ("t:<title>"), which Chrome's own
// target events only update lazily.
var pageScript = fmt.Sprintf(`(() => {
  if (window.%[1]sInstalled) return;
  window.%[1]sInstalled = true;
  const send = (s) => window.%[1]s?.(s);
  const plain = /^(button|submit|reset|checkbox|radio|range|color|file|image)$/;
  let cursor = "";
  addEventListener("mousemove", (e) => {
    const t = e.target;
    let c = "default";
    try { c = getComputedStyle(t).cursor; } catch {}
    if (c.includes(",")) c = c.slice(c.lastIndexOf(",") + 1).trim(); // url(...), fallback
    if (c === "auto") {
      const editable = t && (t.isContentEditable || t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && !plain.test(t.type)));
      c = editable ? "text" : "default";
    }
    if (c !== cursor) { cursor = c; send("c:" + c); }
  }, { capture: true, passive: true });
  let title = null;
  const report = () => { if (document.title !== title) { title = document.title; send("t:" + title); } };
  const watch = () => {
    report();
    if (document.head) new MutationObserver(report).observe(document.head, { subtree: true, childList: true, characterData: true });
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", watch, { once: true });
  else watch();
  let editing = null;
  const focus = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    const e = !!a && (a.isContentEditable || a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && !plain.test(a.type)));
    if (e !== editing) { editing = e; send("f:" + (e ? 1 : 0)); }
  };
  addEventListener("focusin", focus, true);
  addEventListener("focusout", () => setTimeout(focus), true);
})()`, pageBinding)

// selectionScript returns the selected text, in a focused field or the page.
const selectionScript = `(() => {
  const a = document.activeElement;
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && typeof a.selectionStart === "number")
    return a.value.slice(a.selectionStart, a.selectionEnd);
  return String(getSelection() ?? "");
})()`

// Viewport is a viewer's view size in CSS pixels, its device pixel ratio,
// and the quality it wants.
type Viewport struct {
	Width, Height int
	DPR           float64
	Quality       int
	Mobile        bool // a touch device: emulate one while the tab fills its view
	Video         bool // the viewer takes WebRTC video instead of JPEG frames
}

func (v Viewport) clamp() Viewport {
	v.Width = clampDim(v.Width, 3840)
	v.Height = clampDim(v.Height, 2160)
	if v.DPR <= 0 {
		v.DPR = 1
	}
	v.DPR = math.Round(min(max(v.DPR, 1), 2)*100) / 100 // 2: the browser renders at most at --force-device-scale-factor
	if v.Quality == 0 {
		v.Quality = 70
	}
	v.Quality = min(max(v.Quality, 20), 95)
	return v
}

// ViewportOf reads the viewport fields of an attach or resize message.
func ViewportOf(m protocol.BrowserClientMsg) Viewport {
	return Viewport{Width: m.Width, Height: m.Height, DPR: m.DPR, Quality: m.Quality, Mobile: m.Mobile, Video: m.Video}
}

type event struct {
	method string
	params json.RawMessage
}

// eventQueue is unbounded so the CDP reader never blocks on a busy tab.
type eventQueue struct {
	mu     sync.Mutex
	items  []event
	signal chan struct{}
}

func (q *eventQueue) push(e event) {
	q.mu.Lock()
	q.items = append(q.items, e)
	q.mu.Unlock()
	select {
	case q.signal <- struct{}{}:
	default:
	}
}

func (q *eventQueue) pop(ctx context.Context) (event, bool) {
	for {
		q.mu.Lock()
		if len(q.items) > 0 {
			e := q.items[0]
			q.items[0] = event{}
			q.items = q.items[1:]
			q.mu.Unlock()
			return e, true
		}
		q.mu.Unlock()
		select {
		case <-q.signal:
		case <-ctx.Done():
			return event{}, false
		}
	}
}

type inputItem struct {
	c   Client // nil for the tab's own requests
	msg protocol.BrowserClientMsg
}

type screencastFrame struct {
	ackID         int
	jpeg          []byte
	width, height int
}

type sentFrame struct {
	hdr  protocol.BrowserFrame
	jpeg []byte
}

type viewerState struct {
	// video viewers get the tab as WebRTC video from the capture host (as
	// vid, once they've sent an offer) instead of JPEG frames.
	video   bool
	vid     string
	quality int

	seq int64 // last frame sent
	// lagging viewers didn't drain within drainWait. Frames stop waiting for
	// them until they catch up, so one slow or dead link doesn't hold back
	// the others; they get the newest frame whenever they have room.
	lagging bool
}

// Tab is one page, shown to any number of viewers.
type Tab struct {
	m                   *Manager
	key                 string
	br                  *chrome
	targetID, sessionID string

	ctx    context.Context
	cancel context.CancelFunc
	events eventQueue
	input  chan inputItem
	frames chan screencastFrame

	mu      sync.Mutex
	viewers map[Client]*viewerState
	state   protocol.BrowserState
	cursor  string
	last    *sentFrame
	seq     int64

	// Owned by the input goroutine.
	vp         Viewport // the latest viewer's; the tab's size in fill mode
	setting    protocol.BrowserViewportSetting
	metrics    metrics
	metricsSet bool
	casting    bool
	cast       castParams
	capturing  bool
	capSize    [2]int
	videoSeq   int
	// Owned by the event goroutine: popups this tab opened, not yet adopted.
	popups map[string]bool
	// Console messages and failed requests, for agents.
	diag diagnostics
}

func newTab(m *Manager, key string, br *chrome, targetID, sessionID string) *Tab {
	ctx, cancel := context.WithCancel(context.Background())
	return &Tab{
		m: m, key: key, br: br, targetID: targetID, sessionID: sessionID,
		ctx: ctx, cancel: cancel,
		events:  eventQueue{signal: make(chan struct{}, 1)},
		input:   make(chan inputItem, 256),
		frames:  make(chan screencastFrame, 4),
		viewers: map[Client]*viewerState{},
		state:   protocol.BrowserState{T: "state", URL: "about:blank", Viewport: protocol.BrowserViewportSetting{Mode: "fill"}},
		popups:  map[string]bool{},
		// Until a viewer says otherwise, e.g. for an agent.
		vp:      Viewport{Width: 1280, Height: 800, DPR: 1, Quality: 70},
		setting: protocol.BrowserViewportSetting{Mode: "fill"},
	}
}

func (t *Tab) call(method string, params, out any) error {
	ctx, cancel := context.WithTimeout(t.ctx, callWait)
	defer cancel()
	return t.br.conn.call(ctx, t.sessionID, method, params, out)
}

func (t *Tab) setup(ctx context.Context) error {
	for _, c := range []struct {
		method string
		params any
	}{
		{"Page.enable", nil},
		{"Runtime.enable", nil},
		{"Network.enable", nil},
		{"Log.enable", nil},
		// Headless pages never have focus otherwise: no caret, no :focus.
		{"Emulation.setFocusEmulationEnabled", map[string]any{"enabled": true}},
		{"Runtime.addBinding", map[string]any{"name": pageBinding}},
		{"Page.addScriptToEvaluateOnNewDocument", map[string]any{"source": pageScript}},
		{"Runtime.evaluate", map[string]any{"expression": pageScript}},
	} {
		if err := t.br.conn.call(ctx, t.sessionID, c.method, c.params, nil); err != nil {
			return err
		}
	}
	return nil
}

func (t *Tab) run() {
	go t.inputLoop()
	go t.frameLoop()
	for {
		e, ok := t.events.pop(t.ctx)
		if !ok {
			return
		}
		t.handleEvent(e)
	}
}

// shut stops the tab and tells its viewers why (unless reason is empty).
func (t *Tab) shut(reason string) {
	t.cancel()
	t.mu.Lock()
	viewers := t.viewers
	t.viewers = map[Client]*viewerState{}
	t.mu.Unlock()
	if h := t.br.video; h != nil {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), callWait)
			defer cancel()
			_ = h.invoke(ctx, nil, "release", t.key)
		}()
	}
	for c := range viewers {
		c.Closed(reason)
	}
}

func (t *Tab) url() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.state.URL
}

func (t *Tab) watched() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.viewers) > 0
}

func (t *Tab) attach(c Client, vp Viewport) {
	video := vp.Video && t.br.video != nil
	t.mu.Lock()
	t.viewers[c] = &viewerState{video: video, quality: vp.Quality}
	state, cursor := t.state, t.cursor
	t.mu.Unlock()
	c.Send(state)
	if cursor != "" {
		c.Send(protocol.BrowserCursor{T: "cursor", Cursor: cursor})
	}
	if vp.Video && !video {
		c.Send(protocol.BrowserNoVideo{T: "novideo", Message: "This browser can't stream video"})
	}
	t.enqueue(c, protocol.BrowserClientMsg{T: "resize", Width: vp.Width, Height: vp.Height, DPR: vp.DPR, Quality: vp.Quality, Mobile: vp.Mobile, Video: vp.Video})
}

func (t *Tab) detach(c Client) {
	t.mu.Lock()
	st := t.viewers[c]
	delete(t.viewers, c)
	empty := len(t.viewers) == 0
	t.mu.Unlock()
	if st != nil && st.vid != "" {
		t.hangup(st.vid)
	}
	if empty {
		t.enqueue(nil, protocol.BrowserClientMsg{T: "idle"})
	} else {
		t.enqueue(nil, protocol.BrowserClientMsg{T: "apply"}) // it may have been the last of its kind
	}
}

// viewerKinds reports whether any viewer takes JPEG frames, and any video.
func (t *Tab) viewerKinds() (jpeg, video bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, st := range t.viewers {
		if st.video {
			video = true
		} else {
			jpeg = true
		}
	}
	return jpeg, video
}

func (t *Tab) viewerOf(c Client) *viewerState {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.viewers[c]
}

func (t *Tab) enqueue(c Client, msg protocol.BrowserClientMsg) {
	select {
	case t.input <- inputItem{c, msg}:
	case <-t.ctx.Done():
	default:
		slog.Warn("browser input queue full, dropping", "t", msg.T)
	}
}

func (t *Tab) broadcast(msg any) {
	t.mu.Lock()
	viewers := make([]Client, 0, len(t.viewers))
	for c := range t.viewers {
		viewers = append(viewers, c)
	}
	t.mu.Unlock()
	for _, c := range viewers {
		c.Send(msg)
	}
}

func (t *Tab) updateState(fn func(s *protocol.BrowserState)) {
	t.mu.Lock()
	next := t.state
	fn(&next)
	changed := next != t.state
	t.state = next
	t.mu.Unlock()
	if changed {
		t.broadcast(next)
	}
}

// --- input ------------------------------------------------------------------

func (t *Tab) inputLoop() {
	var next *inputItem
	for {
		var it inputItem
		if next != nil {
			it, next = *next, nil
		} else {
			select {
			case it = <-t.input:
			case <-t.ctx.Done():
				return
			}
		}
		// Only the latest of a run of pointer moves matters.
		if isMove(it.msg) {
		drain:
			for {
				select {
				case n := <-t.input:
					if isMove(n.msg) {
						it = n
						continue
					}
					next = &n
					break drain
				default:
					break drain
				}
			}
		}
		if err := t.handleInput(it); err != nil && t.ctx.Err() == nil {
			slog.Debug("browser input", "t", it.msg.T, "err", err)
		}
	}
}

func isMove(m protocol.BrowserClientMsg) bool {
	return (m.T == "mouse" || m.T == "touch") && m.Kind == "move"
}

var mouseTypes = map[string]string{"move": "mouseMoved", "down": "mousePressed", "up": "mouseReleased", "wheel": "mouseWheel"}

var buttonNames = []string{"left", "middle", "right", "back", "forward"}

var touchTypes = map[string]string{"start": "touchStart", "move": "touchMove", "end": "touchEnd", "cancel": "touchCancel"}

func (t *Tab) handleInput(it inputItem) error {
	m := it.msg
	switch m.T {
	case "resize":
		t.vp = ViewportOf(m).clamp()
		if st := t.viewerOf(it.c); st != nil && st.video && st.vid != "" && st.quality != t.vp.Quality {
			st.quality = t.vp.Quality
			_ = t.videoCall(nil, "tune", st.vid, kbpsFor(st.quality))
		}
		return t.applyViewport()
	case "recapture": // the capture ended on its own
		t.capturing = false
		return t.applyViewport()
	case "offer":
		return t.answer(it.c, m.SDP)
	case "ice":
		if st := t.viewerOf(it.c); st != nil && st.vid != "" && len(m.Candidate) > 0 {
			return t.videoCall(nil, "ice", st.vid, m.Candidate)
		}
	case "apply": // the tab's own, when it opens
		return t.applyViewport()
	case "viewport":
		v, err := ResolveViewport(m.Mode, m.Preset, m.Orientation, m.Width, m.Height)
		if err != nil {
			if it.c != nil {
				it.c.Send(protocol.BrowserNotice{T: "notice", Message: err.Error()})
			}
			return nil
		}
		t.setting = v
		return t.applyViewport()
	case "appearance":
		cs := m.ColorScheme
		if cs != "" && cs != "light" && cs != "dark" {
			return nil
		}
		if err := t.call("Emulation.setEmulatedMedia", map[string]any{
			"features": []map[string]string{{"name": "prefers-color-scheme", "value": cs}},
		}, nil); err != nil {
			return err
		}
		t.updateState(func(s *protocol.BrowserState) { s.ColorScheme = cs })
	case "idle":
		if t.watched() {
			return nil
		}
		if t.capturing {
			t.capturing = false
			_ = t.videoCall(nil, "release", t.key)
		}
		if t.casting {
			t.casting = false
			return t.call("Page.stopScreencast", nil, nil)
		}
	case "navigate":
		u, err := checkURL(m.URL)
		if err != nil {
			if it.c != nil {
				it.c.Send(protocol.BrowserNotice{T: "notice", Message: err.Error()})
			}
			return nil
		}
		return t.call("Page.navigate", map[string]any{"url": u}, nil)
	case "back", "forward":
		var h struct {
			CurrentIndex int `json:"currentIndex"`
			Entries      []struct {
				ID int `json:"id"`
			} `json:"entries"`
		}
		if err := t.call("Page.getNavigationHistory", nil, &h); err != nil {
			return err
		}
		i := h.CurrentIndex - 1
		if m.T == "forward" {
			i = h.CurrentIndex + 1
		}
		if i < 0 || i >= len(h.Entries) {
			return nil
		}
		return t.call("Page.navigateToHistoryEntry", map[string]any{"entryId": h.Entries[i].ID}, nil)
	case "reload":
		return t.call("Page.reload", nil, nil)
	case "stop":
		return t.call("Page.stopLoading", nil, nil)
	case "mouse":
		typ, ok := mouseTypes[m.Kind]
		if !ok {
			return nil
		}
		button := "none"
		switch {
		case typ == "mousePressed" || typ == "mouseReleased":
			if m.Button >= 0 && m.Button < len(buttonNames) {
				button = buttonNames[m.Button]
			}
		case typ == "mouseMoved" && m.Buttons&1 != 0:
			button = "left"
		case typ == "mouseMoved" && m.Buttons&4 != 0:
			button = "middle"
		case typ == "mouseMoved" && m.Buttons&2 != 0:
			button = "right"
		}
		p := map[string]any{
			"type": typ, "x": m.X, "y": m.Y, "modifiers": m.Modifiers,
			"button": button, "buttons": m.Buttons, "pointerType": "mouse",
		}
		if typ == "mousePressed" || typ == "mouseReleased" {
			p["clickCount"] = max(m.ClickCount, 1)
		}
		if typ == "mouseWheel" {
			p["deltaX"], p["deltaY"] = m.DeltaX, m.DeltaY
		}
		return t.call("Input.dispatchMouseEvent", p, nil)
	case "key":
		typ := "keyUp"
		if m.Kind == "down" {
			typ = "rawKeyDown"
			if m.Text != "" {
				typ = "keyDown" // also produces keypress and input
			}
		}
		p := map[string]any{
			"type": typ, "modifiers": m.Modifiers, "key": m.Key, "code": m.Code,
			"windowsVirtualKeyCode": m.KeyCode, "nativeVirtualKeyCode": m.KeyCode,
			"location": m.Location, "autoRepeat": m.Repeat, "isKeypad": m.Location == 3,
		}
		if typ == "keyDown" {
			p["text"], p["unmodifiedText"] = m.Text, m.Text
		}
		return t.call("Input.dispatchKeyEvent", p, nil)
	case "text":
		if m.Text == "" {
			return nil
		}
		return t.call("Input.insertText", map[string]any{"text": m.Text}, nil)
	case "touch":
		typ, ok := touchTypes[m.Kind]
		if !ok {
			return nil
		}
		points := make([]map[string]any, 0, len(m.Points))
		for _, p := range m.Points {
			points = append(points, map[string]any{"x": p.X, "y": p.Y, "id": p.ID, "radiusX": 8, "radiusY": 8, "force": 1})
		}
		return t.call("Input.dispatchTouchEvent", map[string]any{"type": typ, "touchPoints": points, "modifiers": m.Modifiers}, nil)
	case "pick":
		el, err := t.elementAt(m.X, m.Y)
		if it.c != nil {
			it.c.Send(protocol.BrowserPicked{T: "picked", ID: m.ID, Element: el})
		}
		return err
	case "copy":
		var r struct {
			Result struct {
				Value string `json:"value"`
			} `json:"result"`
		}
		if err := t.call("Runtime.evaluate", map[string]any{"expression": selectionScript, "returnByValue": true}, &r); err != nil {
			return err
		}
		if it.c != nil && r.Result.Value != "" {
			it.c.Send(protocol.BrowserClipboard{T: "clipboard", Text: r.Result.Value})
		}
	}
	return nil
}

// checkURL allows web pages and about:blank.
func checkURL(raw string) (string, error) {
	if raw == "about:blank" {
		return raw, nil
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("can't open %q: only http and https pages", raw)
	}
	return u.String(), nil
}

type metrics struct {
	width, height int
	dpr           float64
	mobile        bool
}

type castParams struct {
	maxWidth, maxHeight, quality int
}

// applyViewport sizes the page for the viewport setting (or, in fill mode,
// the latest viewer) and screencasts it while anyone watches.
func (t *Tab) applyViewport() error {
	m := metrics{t.vp.Width, t.vp.Height, t.vp.DPR, t.vp.Mobile}
	if t.setting.Mode != "fill" {
		m.width, m.height, m.mobile = t.setting.Width, t.setting.Height, t.setting.Mobile
	}
	if !t.metricsSet || m != t.metrics {
		if err := t.call("Emulation.setDeviceMetricsOverride", map[string]any{
			"width": m.width, "height": m.height, "deviceScaleFactor": m.dpr, "mobile": m.mobile,
		}, nil); err != nil {
			return err
		}
		if !t.metricsSet || m.mobile != t.metrics.mobile {
			if err := t.emulateMobile(m.mobile); err != nil {
				return err
			}
		}
		t.metrics, t.metricsSet = m, true
	}
	shown := t.setting
	if shown.Mode == "fill" {
		shown.Width, shown.Height, shown.Mobile = m.width, m.height, m.mobile
	}
	t.updateState(func(s *protocol.BrowserState) { s.Viewport = shown })

	if !t.watched() {
		return nil
	}
	cast := castParams{
		maxWidth:  int(math.Ceil(float64(m.width) * m.dpr)),
		maxHeight: int(math.Ceil(float64(m.height) * m.dpr)),
		quality:   t.vp.Quality,
	}
	jpeg, video := t.viewerKinds()
	if video {
		if err := t.capture(cast.maxWidth, cast.maxHeight); err != nil {
			slog.Warn("browser video capture failed; streaming JPEG", "err", err)
			t.dropVideo("Couldn't capture the page as video: " + err.Error())
			jpeg = true
		}
	} else if t.capturing {
		t.capturing = false
		_ = t.videoCall(nil, "release", t.key)
	}
	if !jpeg {
		if t.casting {
			t.casting = false
			return t.call("Page.stopScreencast", nil, nil)
		}
		return nil
	}
	if t.casting && cast == t.cast {
		return nil
	}
	if t.casting {
		_ = t.call("Page.stopScreencast", nil, nil)
	}
	t.casting, t.cast = true, cast
	return t.call("Page.startScreencast", map[string]any{
		"format":        "jpeg",
		"quality":       cast.quality,
		"maxWidth":      cast.maxWidth,
		"maxHeight":     cast.maxHeight,
		"everyNthFrame": 1,
	}, nil)
}

// --- video ------------------------------------------------------------------

// videoCall calls the capture host; nil if there is none.
func (t *Tab) videoCall(out any, fn string, args ...any) error {
	h := t.br.video
	if h == nil {
		return errors.New("no video")
	}
	ctx, cancel := context.WithTimeout(t.ctx, callWait)
	defer cancel()
	return h.invoke(ctx, out, fn, args...)
}

// capture (re)starts the tab's capture at width x height device pixels.
func (t *Tab) capture(width, height int) error {
	size := [2]int{width, height}
	if t.capturing && t.capSize == size {
		return nil
	}
	if err := t.videoCall(nil, "capture", t.key, t.targetID, width, height); err != nil {
		t.capturing = false
		return err
	}
	t.capturing, t.capSize = true, size
	return nil
}

// dropVideo moves every video viewer to JPEG frames.
func (t *Tab) dropVideo(reason string) {
	t.mu.Lock()
	var to []Client
	var vids []string
	for c, st := range t.viewers {
		if st.video {
			if st.vid != "" {
				vids = append(vids, st.vid)
			}
			st.video, st.vid, st.seq = false, "", 0
			to = append(to, c)
		}
	}
	t.mu.Unlock()
	for _, vid := range vids {
		t.hangup(vid)
	}
	for _, c := range to {
		c.Send(protocol.BrowserNoVideo{T: "novideo", Message: reason})
	}
}

// answer answers a viewer's offer for the tab's video. Its candidates follow
// as "ice" messages, possibly before the answer itself.
func (t *Tab) answer(c Client, sdp string) error {
	st := t.viewerOf(c)
	if c == nil || st == nil {
		return nil
	}
	if !st.video {
		c.Send(protocol.BrowserNoVideo{T: "novideo", Message: "This browser can't stream video"})
		return nil
	}
	if err := t.applyViewport(); err != nil {
		return err
	}
	if !t.capturing {
		return nil // applyViewport moved it to JPEG
	}
	t.videoSeq++
	vid := fmt.Sprintf("%s#%d", t.key, t.videoSeq)
	t.mu.Lock()
	old := st.vid
	st.vid = vid
	t.mu.Unlock()
	if old != "" {
		t.hangup(old)
	}
	var servers any = []any{}
	if t.m.ICEServers != nil {
		servers = t.m.ICEServers()
	}
	var answer string
	if err := t.videoCall(&answer, "answer", t.key, vid, sdp, servers, kbpsFor(st.quality)); err != nil {
		c.Send(protocol.BrowserNotice{T: "notice", Message: "Couldn't start the video: " + err.Error()})
		t.dropVideo("Couldn't start the video")
		return t.applyViewport()
	}
	c.Send(protocol.BrowserAnswer{T: "answer", SDP: answer})
	return nil
}

func (t *Tab) hangup(vid string) {
	if h := t.br.video; h != nil {
		ctx, cancel := context.WithTimeout(context.Background(), callWait)
		defer cancel()
		_ = h.invoke(ctx, nil, "hangup", vid)
	}
}

// videoViewer finds the viewer that vid belongs to.
func (t *Tab) videoViewer(vid string) Client {
	t.mu.Lock()
	defer t.mu.Unlock()
	for c, st := range t.viewers {
		if st.vid == vid {
			return c
		}
	}
	return nil
}

// emulateMobile turns touch input and a phone's user agent on or off. Pages
// pick the new user agent up on their next load.
func (t *Tab) emulateMobile(on bool) error {
	if err := t.call("Emulation.setTouchEmulationEnabled", map[string]any{"enabled": on, "maxTouchPoints": 5}, nil); err != nil {
		return err
	}
	ua := t.br.userAgent
	if on {
		ua = mobileUA(ua)
	}
	return t.call("Emulation.setUserAgentOverride", map[string]any{"userAgent": ua}, nil)
}

// mobileUA turns a desktop Chrome user agent into Chrome for Android's.
func mobileUA(ua string) string {
	if i := strings.Index(ua, "("); i >= 0 {
		if j := strings.Index(ua[i:], ")"); j >= 0 {
			ua = ua[:i] + "(Linux; Android 10; K)" + ua[i+j+1:]
		}
	}
	return strings.Replace(ua, " Safari/", " Mobile Safari/", 1)
}

// --- frames -----------------------------------------------------------------

// frameLoop fans frames out to viewers. Chrome sends the next frame only
// after an ack, and the ack waits briefly for viewers to drain, so frames
// don't pile up in a queue; a viewer that can't keep up skips to the newest
// frame instead of holding back the rest.
func (t *Tab) frameLoop() {
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case f := <-t.frames:
			t.mu.Lock()
			t.seq++
			t.last = &sentFrame{
				hdr:  protocol.BrowserFrame{T: "frame", Seq: t.seq, Size: len(f.jpeg), Width: f.width, Height: f.height},
				jpeg: f.jpeg,
			}
			t.mu.Unlock()
			t.flush()
			t.waitDrain()
			_ = t.call("Page.screencastFrameAck", map[string]any{"sessionId": f.ackID}, nil)
		case <-tick.C:
			// Catch up viewers that skipped the last frame or just attached.
			t.flush()
		case <-t.ctx.Done():
			return
		}
	}
}

// flush sends the latest frame to every viewer that lacks it and has room.
func (t *Tab) flush() {
	t.mu.Lock()
	last := t.last
	if last == nil {
		t.mu.Unlock()
		return
	}
	var to []Client
	for c, st := range t.viewers {
		if !st.video && st.seq < last.hdr.Seq && c.Buffered() < lowWater {
			st.seq = last.hdr.Seq
			st.lagging = false
			to = append(to, c)
		}
	}
	t.mu.Unlock()
	for _, c := range to {
		c.Frame(last.hdr, last.jpeg)
	}
}

func (t *Tab) waitDrain() {
	deadline := time.Now().Add(drainWait)
	for {
		t.mu.Lock()
		var busy []*viewerState
		for c, st := range t.viewers {
			if !st.video && !st.lagging && c.Buffered() >= lowWater {
				busy = append(busy, st)
			}
		}
		if len(busy) > 0 && !time.Now().Before(deadline) {
			for _, st := range busy {
				st.lagging = true
			}
			busy = nil
		}
		t.mu.Unlock()
		if len(busy) == 0 {
			return
		}
		select {
		case <-time.After(5 * time.Millisecond):
		case <-t.ctx.Done():
			return
		}
	}
}

// --- events -----------------------------------------------------------------

func (t *Tab) handleEvent(e event) {
	t.diag.note(e.method, e.params)
	switch e.method {
	case "Page.screencastFrame":
		var p struct {
			Data      []byte `json:"data"`
			SessionID int    `json:"sessionId"`
			Metadata  struct {
				DeviceWidth  float64 `json:"deviceWidth"`
				DeviceHeight float64 `json:"deviceHeight"`
			} `json:"metadata"`
		}
		if json.Unmarshal(e.params, &p) != nil {
			return
		}
		f := screencastFrame{ackID: p.SessionID, jpeg: p.Data, width: int(math.Round(p.Metadata.DeviceWidth)), height: int(math.Round(p.Metadata.DeviceHeight))}
		select {
		case t.frames <- f:
		case <-t.ctx.Done():
		}
	case "Page.frameStartedLoading", "Page.frameStoppedLoading":
		var p struct {
			FrameID string `json:"frameId"`
		}
		if json.Unmarshal(e.params, &p) == nil && p.FrameID == t.targetID {
			loading := e.method == "Page.frameStartedLoading"
			t.updateState(func(s *protocol.BrowserState) { s.Loading = loading })
		}
	case "Page.frameNavigated":
		var p struct {
			Frame struct {
				ParentID string `json:"parentId"`
				URL      string `json:"url"`
				Fragment string `json:"urlFragment"`
			} `json:"frame"`
		}
		if json.Unmarshal(e.params, &p) == nil && p.Frame.ParentID == "" {
			t.updateState(func(s *protocol.BrowserState) { s.URL = p.Frame.URL + p.Frame.Fragment })
			t.refreshHistory()
		}
	case "Page.navigatedWithinDocument":
		var p struct {
			FrameID string `json:"frameId"`
			URL     string `json:"url"`
		}
		if json.Unmarshal(e.params, &p) == nil && p.FrameID == t.targetID {
			t.updateState(func(s *protocol.BrowserState) { s.URL = p.URL })
			t.refreshHistory()
		}
	case "Target.targetInfoChanged":
		var p struct {
			TargetInfo targetInfo `json:"targetInfo"`
		}
		if json.Unmarshal(e.params, &p) != nil {
			return
		}
		info := p.TargetInfo
		if info.TargetID == t.targetID {
			// The page script reports titles; this only fills in pages it
			// can't run in, like Chrome's error pages.
			if info.Title != "" && info.Title != info.URL {
				t.updateState(func(s *protocol.BrowserState) { s.Title = info.Title })
			}
		} else if t.popups[info.TargetID] {
			t.adoptPopup(info)
		}
	case "Target.targetCreated":
		var p struct {
			TargetInfo targetInfo `json:"targetInfo"`
		}
		if json.Unmarshal(e.params, &p) == nil && p.TargetInfo.Type == "page" && p.TargetInfo.OpenerID == t.targetID {
			t.popups[p.TargetInfo.TargetID] = true
			t.m.watchTarget(p.TargetInfo.TargetID, t)
			t.adoptPopup(p.TargetInfo)
		}
	case "Target.targetDestroyed", "Target.targetCrashed":
		var p struct {
			TargetID string `json:"targetId"`
		}
		if json.Unmarshal(e.params, &p) != nil {
			return
		}
		if p.TargetID == t.targetID {
			go t.m.tabGone(t)
		} else if t.popups[p.TargetID] {
			delete(t.popups, p.TargetID)
			t.m.unwatchTarget(p.TargetID)
		}
	case "Inspector.targetCrashed":
		t.broadcast(protocol.BrowserNotice{T: "notice", Message: "The page crashed; reloading"})
		_ = t.call("Page.reload", nil, nil)
	case "Page.javascriptDialogOpening":
		var p struct {
			Type          string `json:"type"`
			Message       string `json:"message"`
			DefaultPrompt string `json:"defaultPrompt"`
		}
		if json.Unmarshal(e.params, &p) != nil {
			return
		}
		// A dialog blocks the page until answered, and there's no UI for one.
		_ = t.call("Page.handleJavaScriptDialog", map[string]any{"accept": true, "promptText": p.DefaultPrompt}, nil)
		if p.Type != "beforeunload" {
			t.broadcast(protocol.BrowserNotice{T: "notice", Message: fmt.Sprintf("The page showed a %s, answered OK: %s", p.Type, p.Message)})
		}
	case "video":
		var v videoEvent
		if json.Unmarshal(e.params, &v) != nil {
			return
		}
		switch v.T {
		case "ice":
			if c := t.videoViewer(v.Viewer); c != nil {
				c.Send(protocol.BrowserICE{T: "ice", Candidate: v.Candidate})
			}
		case "ended":
			t.enqueue(nil, protocol.BrowserClientMsg{T: "recapture"})
		}
	case "Runtime.bindingCalled":
		var p struct {
			Name    string `json:"name"`
			Payload string `json:"payload"`
		}
		if json.Unmarshal(e.params, &p) != nil || p.Name != pageBinding {
			return
		}
		kind, value, _ := strings.Cut(p.Payload, ":")
		switch kind {
		case "c":
			t.mu.Lock()
			changed := t.cursor != value
			t.cursor = value
			t.mu.Unlock()
			if changed {
				t.broadcast(protocol.BrowserCursor{T: "cursor", Cursor: value})
			}
		case "t":
			t.updateState(func(s *protocol.BrowserState) { s.Title = value })
		case "f":
			t.updateState(func(s *protocol.BrowserState) { s.Editing = value == "1" })
		}
	}
}

// adoptPopup loads a page that asked for a new window (target=_blank,
// window.open) in this tab instead, once its URL is known.
func (t *Tab) adoptPopup(info targetInfo) {
	if info.URL == "" || info.URL == "about:blank" {
		return
	}
	delete(t.popups, info.TargetID)
	t.m.unwatchTarget(info.TargetID)
	_ = t.br.conn.call(t.ctx, "", "Target.closeTarget", map[string]any{"targetId": info.TargetID}, nil)
	t.enqueue(nil, protocol.BrowserClientMsg{T: "navigate", URL: info.URL})
}

func (t *Tab) refreshHistory() {
	var h struct {
		CurrentIndex int   `json:"currentIndex"`
		Entries      []any `json:"entries"`
	}
	if t.call("Page.getNavigationHistory", nil, &h) != nil {
		return
	}
	t.updateState(func(s *protocol.BrowserState) {
		s.CanGoBack = h.CurrentIndex > 0
		s.CanGoForward = h.CurrentIndex < len(h.Entries)-1
	})
}
