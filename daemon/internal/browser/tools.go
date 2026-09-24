package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
)

// Screenshots in tool results go into the model's context, so they're kept
// small.
const (
	snapshotMaxSide = 1280
	snapshotRecent  = 30 // console messages, failed requests and actions
	defaultWait     = 10 * time.Second
	maxWait         = 60 * time.Second
)

// ToolNames lists the browser tools, for allowing them without prompts.
func ToolNames() []string {
	names := make([]string, 0, len(toolDefs))
	for _, d := range toolDefs {
		names = append(names, d.name)
	}
	return names
}

// Tools returns the MCP tools that drive the caller's thread's tab.
func Tools(m *Manager) []mcp.Tool {
	tools := make([]mcp.Tool, 0, len(toolDefs))
	for _, d := range toolDefs {
		run := d.run
		tools = append(tools, mcp.Tool{
			Name: d.name, Title: d.title, Description: d.description,
			InputSchema: json.RawMessage(d.schema),
			Annotations: d.annotations,
			Call: func(ctx context.Context, c mcp.Caller, args json.RawMessage) (*mcp.Result, error) {
				if c.Browser == "" {
					return nil, errors.New("this session has no thread to browse for")
				}
				t, err := m.Use(ctx, c.Browser)
				if err != nil {
					return nil, fmt.Errorf("starting the browser: %w", err)
				}
				return run(ctx, t, args)
			},
		})
	}
	return tools
}

type toolDef struct {
	name, title, description string
	schema                   string
	annotations              mcp.Annotations
	run                      func(ctx context.Context, t *Tab, args json.RawMessage) (*mcp.Result, error)
}

var (
	// Only looks at the page.
	readOnly = mcp.Annotations{ReadOnly: true, Idempotent: true, OpenWorld: true}
	// Changes how the page is shown, not its state.
	safe = mcp.Annotations{OpenWorld: true}
	// Acts on the page like a user, which can change or destroy its state.
	acting = mcp.Annotations{Destructive: true, OpenWorld: true}
)

const targetProps = `
    "selector": {"type": "string", "description": "CSS selector of the element. It must match exactly one visible element."},
    "text": {"type": "string", "description": "Visible text, label, aria-label or placeholder of the element: an exact match is preferred over a substring, and interactive elements over others."}`

var toolDefs = []toolDef{
	{
		name: "browser_status", title: "Browser status", annotations: readOnly,
		description: "Report the state of this thread's browser tab (a headless Chrome on the user's machine, which the user may also be watching in the everywhere app): URL, title, whether it is loading, the viewport setting, the emulated color scheme, and whether anyone is watching.",
		schema:      `{"type": "object", "properties": {}}`,
		run: func(_ context.Context, t *Tab, _ json.RawMessage) (*mcp.Result, error) {
			return mcp.JSON(statusOf(t))
		},
	},
	{
		name: "browser_navigate", title: "Navigate browser", annotations: safe,
		description: "Open a page in this thread's browser tab. Give {url} for any http(s) page (a URL without a scheme gets http for localhost and https otherwise), or {port, path} for a dev server on this machine (http://localhost:PORT/path). The browser runs on the same machine as the project, so localhost works. Returns the page's status once it reaches readiness.",
		schema: `{"type": "object", "properties": {
    "url": {"type": "string", "description": "Page URL, e.g. http://localhost:5173/settings or example.com."},
    "port": {"type": "integer", "minimum": 1, "maximum": 65535, "description": "Dev-server port on this machine, instead of url."},
    "path": {"type": "string", "description": "With port: path, query and fragment, e.g. /settings?tab=account."},
    "readiness": {"type": "string", "enum": ["load", "domContentLoaded", "none"], "description": "What to wait for before returning: load (default) waits for the page to finish loading, domContentLoaded for its HTML to be parsed, none returns at once."},
    "timeoutMs": {"type": "integer", "minimum": 1, "maximum": 60000, "description": "Longest to wait for readiness, in ms. Default 15000."}
  }}`,
		run: func(ctx context.Context, t *Tab, args json.RawMessage) (*mcp.Result, error) {
			var a struct {
				URL       string `json:"url"`
				Port      int    `json:"port"`
				Path      string `json:"path"`
				Readiness string `json:"readiness"`
				TimeoutMs int    `json:"timeoutMs"`
			}
			if err := decode(args, &a); err != nil {
				return nil, err
			}
			if a.URL != "" && a.Port != 0 {
				return nil, errors.New("give url or port, not both")
			}
			switch a.Readiness {
			case "", "load", "domContentLoaded", "none":
			default:
				return nil, fmt.Errorf("unknown readiness %q", a.Readiness)
			}
			u, err := NavigateURL(a.URL, a.Port, a.Path)
			if err != nil {
				return nil, err
			}
			ready, err := t.Navigate(ctx, u, a.Readiness, waitTime(a.TimeoutMs, 15*time.Second))
			if err != nil {
				if a.Port != 0 {
					err = fmt.Errorf("%w (is a server listening on port %d?)", err, a.Port)
				}
				return nil, err
			}
			st := statusOf(t)
			if !ready {
				st.Note = "The page is still loading; call browser_wait_for or browser_snapshot to check on it."
			}
			return mcp.JSON(st)
		},
	},
	{
		name: "browser_resize", title: "Resize browser viewport", annotations: withIdempotent(safe),
		description: "Size this thread's browser viewport. {mode:'fill'} follows the size of whoever is watching (1280x800 when nobody is); {mode:'freeform', width, height} sets an exact size in CSS pixels; {mode:'preset', preset, orientation?} emulates a device, including its touch input and, for phones and tablets, a mobile user agent (applied on the next page load). Presets: " + presetList() + ".",
		schema: `{"type": "object", "required": ["mode"], "properties": {
    "mode": {"type": "string", "enum": ["fill", "preset", "freeform"]},
    "preset": {"type": "string", "description": "Device preset id, for mode preset."},
    "orientation": {"type": "string", "enum": ["portrait", "landscape"], "description": "For mode preset; defaults to the device's own."},
    "width": {"type": "integer", "minimum": 200, "maximum": 3840, "description": "For mode freeform, in CSS pixels."},
    "height": {"type": "integer", "minimum": 200, "maximum": 2160, "description": "For mode freeform, in CSS pixels."}
  }}`,
		run: func(ctx context.Context, t *Tab, args json.RawMessage) (*mcp.Result, error) {
			var a struct {
				Mode, Preset, Orientation string
				Width, Height             int
			}
			if err := decode(args, &a); err != nil {
				return nil, err
			}
			setting, err := t.SetViewport(ctx, a.Mode, a.Preset, a.Orientation, a.Width, a.Height)
			if err != nil {
				return nil, err
			}
			return mcp.JSON(map[string]any{"viewport": setting})
		},
	},
	{
		name: "browser_set_appearance", title: "Set browser appearance", annotations: withIdempotent(safe),
		description: "Emulate prefers-color-scheme in this thread's browser tab: light or dark, or system to stop emulating and follow the machine's setting.",
		schema: `{"type": "object", "required": ["colorScheme"], "properties": {
    "colorScheme": {"type": "string", "enum": ["light", "dark", "system"]}
  }}`,
		run: func(ctx context.Context, t *Tab, args json.RawMessage) (*mcp.Result, error) {
			var a struct {
				ColorScheme string `json:"colorScheme"`
			}
			if err := decode(args, &a); err != nil {
				return nil, err
			}
			scheme := a.ColorScheme
			if scheme == "system" {
				scheme = ""
			} else if scheme == "" {
				return nil, errors.New("give colorScheme: light, dark or system")
			}
			if err := t.SetColorScheme(ctx, scheme); err != nil {
				return nil, err
			}
			return mcp.JSON(map[string]string{"colorScheme": a.ColorScheme})
		},
	},
	{
		name: "browser_snapshot", title: "Inspect browser page", annotations: readOnly,
		description: "Inspect this thread's browser tab before acting on it. Returns the URL and title, the page's visible text (up to 20000 characters), up to 200 visible elements (interactive ones, headings, images) with a CSS selector, role, accessible name and viewport rectangle in CSS pixels, recent console messages and errors, failed network requests, recent browser actions, and a screenshot of the viewport (scaled to at most 1280px). Set includeImage=false for text only. Set save=true to also save a full-resolution PNG and get its absolute path back as screenshotPath; to show the user the screenshot, put ![description](screenshotPath) in your reply. The image in the tool result itself is not shown to the user.",
		schema: `{"type": "object", "properties": {
    "includeImage": {"type": "boolean", "description": "Include a screenshot in the result. Default true."},
    "save": {"type": "boolean", "description": "Save a full-resolution PNG screenshot and return its path. Default false."}
  }}`,
		run: func(ctx context.Context, t *Tab, args json.RawMessage) (*mcp.Result, error) {
			a := struct {
				IncludeImage *bool `json:"includeImage"`
				Save         bool  `json:"save"`
			}{}
			if err := decode(args, &a); err != nil {
				return nil, err
			}
			snap, err := t.Snapshot(ctx, snapshotRecent)
			if err != nil {
				return nil, err
			}
			out := struct {
				*PageSnapshot
				ScreenshotPath string `json:"screenshotPath,omitempty"`
			}{PageSnapshot: snap}
			if a.Save {
				if out.ScreenshotPath, err = t.SaveScreenshot(ctx); err != nil {
					snap.Warnings = append(snap.Warnings, "couldn't save a screenshot: "+err.Error())
				}
			}
			var img []byte
			if a.IncludeImage == nil || *a.IncludeImage {
				if img, _, _, err = t.Screenshot(ctx, "jpeg", snapshotMaxSide); err != nil {
					snap.Warnings = append(snap.Warnings, "couldn't take a screenshot: "+err.Error())
				}
			}
			res, err := mcp.JSON(out)
			if err != nil {
				return nil, err
			}
			if img != nil {
				res.Image(img, "image/jpeg")
			}
			return res, nil
		},
	},
	{
		name: "browser_click", title: "Click in browser", annotations: acting,
		description: "Click one element in this thread's browser tab, like a user with a mouse: it is scrolled into view and clicked at its centre. Target it by CSS selector, by its visible text, or by x/y viewport coordinates in CSS pixels (as in browser_snapshot). Fails if nothing or more than one visible element matches. Use browser_snapshot first to find targets.",
		schema: `{"type": "object", "properties": {` + targetProps + `,
    "x": {"type": "number", "description": "Viewport x in CSS pixels, with y."},
    "y": {"type": "number", "description": "Viewport y in CSS pixels, with x."},
    "button": {"type": "string", "enum": ["left", "right", "middle"], "description": "Default left."},
    "clickCount": {"type": "integer", "minimum": 1, "maximum": 3, "description": "2 for a double click. Default 1."}
  }}`,
		run: func(ctx context.Context, t *Tab, args json.RawMessage) (*mcp.Result, error) {
			var a struct {
				Selector   string   `json:"selector"`
				Text       string   `json:"text"`
				X          *float64 `json:"x"`
				Y          *float64 `json:"y"`
				Button     string   `json:"button"`
				ClickCount int      `json:"clickCount"`
			}
			if err := decode(args, &a); err != nil {
				return nil, err
			}
			tg := Target{Selector: a.Selector, Text: a.Text, X: a.X, Y: a.Y}
			if err := oneTarget(tg); err != nil {
				return nil, err
			}
			h, err := t.Click(ctx, tg, a.Button, a.ClickCount)
			if err != nil {
				return nil, err
			}
			return actionResult(ctx, t, "clicked", h)
		},
	},
	{
		name: "browser_type", title: "Type in browser", annotations: acting,
		description: "Type literal text into this thread's browser tab. With selector or target, that field is clicked to focus it first; otherwise the text goes to whatever has focus. clear=true replaces the field's contents; submit=true presses Enter afterwards.",
		schema: `{"type": "object", "required": ["text"], "properties": {
    "text": {"type": "string", "description": "The text to type."},
    "selector": {"type": "string", "description": "CSS selector of the field. It must match exactly one visible element."},
    "target": {"type": "string", "description": "Visible text, label, aria-label or placeholder of the field, instead of selector."},
    "clear": {"type": "boolean", "description": "Clear the field before typing. Default false."},
    "submit": {"type": "boolean", "description": "Press Enter after typing. Default false."}
  }}`,
		run: func(ctx context.Context, t *Tab, args json.RawMessage) (*mcp.Result, error) {
			var a struct {
				Text     *string `json:"text"`
				Selector string  `json:"selector"`
				Target   string  `json:"target"`
				Clear    bool    `json:"clear"`
				Submit   bool    `json:"submit"`
			}
			if err := decode(args, &a); err != nil {
				return nil, err
			}
			if a.Text == nil {
				return nil, errors.New("give the text to type")
			}
			var tg *Target
			if a.Selector != "" || a.Target != "" {
				tg = &Target{Selector: a.Selector, Text: a.Target}
				if err := oneTarget(*tg); err != nil {
					return nil, err
				}
			}
			h, err := t.Type(ctx, tg, *a.Text, a.Clear, a.Submit)
			if err != nil {
				return nil, err
			}
			return actionResult(ctx, t, "typed", h)
		},
	},
	{
		name: "browser_press", title: "Press key in browser", annotations: acting,
		description: "Press one key in this thread's browser tab, sent to whatever has focus. Keys: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12, Space, or a single character. Hold modifiers with modifiers:['Control'] or write a combination like 'Control+a'.",
		schema: `{"type": "object", "required": ["key"], "properties": {
    "key": {"type": "string", "description": "Key name or single character."},
    "modifiers": {"type": "array", "items": {"type": "string", "enum": ["Alt", "Control", "Meta", "Shift"]}, "description": "Modifier keys held while pressing key."}
  }}`,
		run: func(ctx context.Context, t *Tab, args json.RawMessage) (*mcp.Result, error) {
			var a struct {
				Key       string   `json:"key"`
				Modifiers []string `json:"modifiers"`
			}
			if err := decode(args, &a); err != nil {
				return nil, err
			}
			if a.Key == "" {
				return nil, errors.New("give a key")
			}
			if err := t.Press(ctx, a.Key, a.Modifiers); err != nil {
				return nil, err
			}
			return actionResult(ctx, t, "pressed "+strings.Join(append(a.Modifiers, a.Key), "+"), nil)
		},
	},
	{
		name: "browser_scroll", title: "Scroll browser", annotations: safe,
		description: "Scroll this thread's browser tab with the mouse wheel: over the middle of the viewport, or over an element (to scroll a scrollable container). Positive deltaY scrolls down, positive deltaX right, in CSS pixels. Returns the scroll position before and after.",
		schema: `{"type": "object", "properties": {` + targetProps + `,
    "deltaX": {"type": "number", "description": "Horizontal distance. Default 0."},
    "deltaY": {"type": "number", "description": "Vertical distance. Default 0."}
  }}`,
		run: func(ctx context.Context, t *Tab, args json.RawMessage) (*mcp.Result, error) {
			var a struct {
				Selector string  `json:"selector"`
				Text     string  `json:"text"`
				DeltaX   float64 `json:"deltaX"`
				DeltaY   float64 `json:"deltaY"`
			}
			if err := decode(args, &a); err != nil {
				return nil, err
			}
			if a.DeltaX == 0 && a.DeltaY == 0 {
				return nil, errors.New("give deltaX or deltaY")
			}
			var tg *Target
			if a.Selector != "" || a.Text != "" {
				tg = &Target{Selector: a.Selector, Text: a.Text}
				if err := oneTarget(*tg); err != nil {
					return nil, err
				}
			}
			r, err := t.Scroll(ctx, tg, a.DeltaX, a.DeltaY)
			if err != nil {
				return nil, err
			}
			return mcp.JSON(r)
		},
	},
	{
		name: "browser_evaluate", title: "Evaluate JavaScript in browser", annotations: acting,
		description: "Evaluate a JavaScript expression in the main frame of this thread's browser tab, like the DevTools console (top-level await works), and return {value}: the result as JSON, up to 64 KB. Values that aren't JSON-serializable (DOM nodes, functions) come back as {} or null. The expression may change the page. Prefer browser_snapshot and the other tools; use this for inspection they can't do.",
		schema: `{"type": "object", "required": ["expression"], "properties": {
    "expression": {"type": "string", "description": "JavaScript expression, e.g. document.title or [...document.querySelectorAll('li')].map(li => li.textContent)."},
    "awaitPromise": {"type": "boolean", "description": "Wait for a returned promise and return its value. Default true."}
  }}`,
		run: func(ctx context.Context, t *Tab, args json.RawMessage) (*mcp.Result, error) {
			var a struct {
				Expression   string `json:"expression"`
				AwaitPromise *bool  `json:"awaitPromise"`
			}
			if err := decode(args, &a); err != nil {
				return nil, err
			}
			if strings.TrimSpace(a.Expression) == "" {
				return nil, errors.New("give an expression")
			}
			v, err := t.Evaluate(ctx, a.Expression, a.AwaitPromise == nil || *a.AwaitPromise)
			if err != nil {
				return nil, err
			}
			b, err := json.Marshal(map[string]json.RawMessage{"value": v})
			if err != nil {
				return nil, err
			}
			return mcp.Text(string(b)), nil
		},
	},
	{
		name: "browser_wait_for", title: "Wait for browser page", annotations: readOnly,
		description: "Wait until this thread's browser tab matches every given condition: a CSS selector matching a visible element, text appearing in the page's visible text (case-sensitive), and/or the URL containing a substring. Use after actions whose effects are asynchronous.",
		schema: `{"type": "object", "properties": {
    "selector": {"type": "string", "description": "CSS selector that must match a visible element."},
    "text": {"type": "string", "description": "Text that must appear in the page's visible text."},
    "urlIncludes": {"type": "string", "description": "Substring the page URL must contain."},
    "timeoutMs": {"type": "integer", "minimum": 1, "maximum": 60000, "description": "Longest to wait, in ms. Default 10000."}
  }}`,
		run: func(ctx context.Context, t *Tab, args json.RawMessage) (*mcp.Result, error) {
			var a struct {
				Selector    string `json:"selector"`
				Text        string `json:"text"`
				URLIncludes string `json:"urlIncludes"`
				TimeoutMs   int    `json:"timeoutMs"`
			}
			if err := decode(args, &a); err != nil {
				return nil, err
			}
			wait := waitTime(a.TimeoutMs, defaultWait)
			start := time.Now()
			if err := t.WaitFor(ctx, WaitCond{Selector: a.Selector, Text: a.Text, URLIncludes: a.URLIncludes}, wait); err != nil {
				return nil, err
			}
			st := statusOf(t)
			st.Note = fmt.Sprintf("matched after %dms", time.Since(start).Milliseconds())
			return mcp.JSON(st)
		},
	},
}

type status struct {
	URL         string `json:"url"`
	Title       string `json:"title"`
	Loading     bool   `json:"loading"`
	Viewport    any    `json:"viewport"`
	ColorScheme string `json:"colorScheme"` // light | dark | system
	Watched     bool   `json:"watched"`     // someone has the tab open in the app
	Note        string `json:"note,omitempty"`
}

func statusOf(t *Tab) status {
	st, watched := t.State()
	cs := st.ColorScheme
	if cs == "" {
		cs = "system"
	}
	return status{URL: st.URL, Title: st.Title, Loading: st.Loading, Viewport: st.Viewport, ColorScheme: cs, Watched: watched}
}

// actionResult reports where an action landed and the page it left.
func actionResult(ctx context.Context, t *Tab, did string, h *Hit) (*mcp.Result, error) {
	// Let whatever the action set off (a navigation, a re-render) start.
	select {
	case <-time.After(150 * time.Millisecond):
	case <-ctx.Done():
	}
	st := statusOf(t)
	out := map[string]any{"result": did, "url": st.URL, "title": st.Title, "loading": st.Loading}
	if h != nil {
		out["at"] = map[string]float64{"x": h.X, "y": h.Y}
		if h.Element != nil {
			out["element"] = h.Element
		}
		if h.Covered != "" {
			out["warning"] = "another element (" + h.Covered + ") covers the target's centre and may have received the input"
		}
	}
	return mcp.JSON(out)
}

func oneTarget(tg Target) error {
	n := 0
	for _, set := range []bool{tg.Selector != "", tg.Text != "", tg.X != nil || tg.Y != nil} {
		if set {
			n++
		}
	}
	if n != 1 {
		return errors.New("give exactly one of selector, text, or x and y")
	}
	return nil
}

func decode(args json.RawMessage, out any) error {
	if err := json.Unmarshal(args, out); err != nil {
		return fmt.Errorf("invalid arguments: %w", err)
	}
	return nil
}

func waitTime(ms int, def time.Duration) time.Duration {
	if ms <= 0 {
		return def
	}
	return min(time.Duration(ms)*time.Millisecond, maxWait)
}

func withIdempotent(a mcp.Annotations) mcp.Annotations {
	a.Idempotent = true
	return a
}

func presetList() string {
	ids := make([]string, 0, len(Presets))
	for _, p := range Presets {
		ids = append(ids, fmt.Sprintf("%s (%s, %dx%d)", p.ID, p.Label, p.Width, p.Height))
	}
	return strings.Join(ids, ", ")
}
