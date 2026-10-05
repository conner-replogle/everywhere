package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
)

// ToolNames lists the desktop tools, for allowing them without prompts.
func ToolNames() []string {
	names := make([]string, 0, len(toolDefs))
	for _, d := range toolDefs {
		names = append(names, d.name)
	}
	return names
}

// Tools returns the MCP tools that let the caller's thread see and use the
// desktop. They're listed while remote desktop is on and usable.
func Tools(m *Manager) []mcp.Tool {
	listed := func() bool { return m.Info().Available && m.enabled() }
	tools := make([]mcp.Tool, 0, len(toolDefs))
	for _, d := range toolDefs {
		run := d.run
		description := d.description
		if o, ok := descriptionOverrides[d.name]; ok {
			description = o
		}
		tools = append(tools, mcp.Tool{
			Name: d.name, Title: d.title, Description: description,
			InputSchema: json.RawMessage(d.schema),
			Annotations: d.annotations,
			Listed:      listed,
			Call: func(ctx context.Context, c mcp.Caller, args json.RawMessage) (*mcp.Result, error) {
				if c.Browser == "" {
					return nil, errors.New("this session has no thread to use the desktop for")
				}
				a, err := m.Agent(c.Browser)
				if err != nil {
					return nil, err
				}
				return run(ctx, a, args)
			},
		})
	}
	return tools
}

type toolDef struct {
	name, title, description string
	schema                   string
	annotations              mcp.Annotations
	run                      func(ctx context.Context, a *Agent, args json.RawMessage) (*mcp.Result, error)
}

var (
	// Only looks.
	readOnly = mcp.Annotations{ReadOnly: true, Idempotent: true}
	// Changes what's shown, not what's in it.
	safe = mcp.Annotations{}
	// Acts like a user at the keyboard and mouse, which can change or destroy anything.
	acting = mcp.Annotations{Destructive: true, OpenWorld: true}
)

// How long an action gets to take effect before the screenshot that follows it.
const settle = 300 * time.Millisecond

// desks explains the two desktops, for the tools that pick one.
const desks = "There are two desktops. Claude's desktop (\"claude\", the default) is a separate one beside the user's, with its own mouse pointer, keyboard focus and clipboard, and apps you start there with desktop_launch: the user keeps working while you use it, and can watch it in the thread's Desktop tab. The user's desktop (\"yours\") is their real screen and apps: acting there moves their mouse pointer and takes their keyboard focus, so use it only when the task needs their own windows."

const coords = "x and y are pixels in the screenshots of the thread's target (desktop_screenshot), whose size every screenshot result reports."

const screenshotProp = `"screenshot": {"type": "boolean", "description": "Return a screenshot after the action. Default true."}`

var toolDefs = []toolDef{
	{
		name: "desktop_list", title: "List desktop windows", annotations: readOnly,
		description: "List the desktop this thread works on (see desktop_open): monitors (name, size, focused, shown workspace), workspaces (and whether they're shown), and windows (id, app class, title, workspace, monitor, size). Also says what this thread's target is: the desktop, and the window or monitor there that desktop_screenshot shows and the input tools act on.",
		schema:      `{"type": "object", "properties": {}}`,
		run: func(ctx context.Context, a *Agent, _ json.RawMessage) (*mcp.Result, error) {
			d, err := a.List()
			if err != nil {
				return nil, err
			}
			out := struct {
				*Desktop
				Target *Target `json:"target,omitempty"`
			}{Desktop: d}
			if v, err := a.Current(); err == nil {
				out.Target = &v.Target
			}
			return mcp.JSON(out)
		},
	},
	{
		name: "desktop_open", title: "Open desktop window", annotations: safe,
		description: "Point this thread at a desktop, and there at one window (by id from desktop_list) or one monitor (by name; neither means the focused monitor). desktop_screenshot then shows it and the input tools act on it; the user sees it in the thread's Desktop tab. A window stays the target when it moves; acting on it focuses it, switching to its workspace. " + desks + " Returns a screenshot.",
		schema: `{"type": "object", "properties": {
    "desktop": {"type": "string", "enum": ["claude", "yours"], "description": "Which desktop. Default: the one this thread is on (at first, Claude's)."},
    "window": {"type": "string", "description": "Window id from desktop_list."},
    "output": {"type": "string", "description": "Monitor name from desktop_list, e.g. DP-1."}
  }}`,
		run: func(ctx context.Context, a *Agent, args json.RawMessage) (*mcp.Result, error) {
			var p struct {
				Desktop string `json:"desktop"`
				Window  string `json:"window"`
				Output  string `json:"output"`
			}
			if err := decode(args, &p); err != nil {
				return nil, err
			}
			if p.Window != "" && p.Output != "" {
				return nil, errors.New("give window or output, not both")
			}
			if _, err := a.Open(p.Desktop, p.Window, p.Output); err != nil {
				return nil, err
			}
			return shotResult(a, map[string]any{"result": "opened"}, false)
		},
	},
	{
		name: "desktop_launch", title: "Launch app on Claude's desktop", annotations: acting,
		description: "Start an app on Claude's desktop, e.g. \"foot\", \"gnome-calculator\" or \"chromium --user-data-dir=/tmp/claude-chromium\", and make that desktop this thread's target. The command runs through the shell. It waits a few seconds for the app's window and returns it with a screenshot. An app that's already running on the user's desktop may open its window there instead (browsers do unless given their own profile directory, as do apps started through D-Bus): check the result. For web pages, the browser_* tools are usually better. " + desks,
		schema: `{"type": "object", "required": ["command"], "properties": {
    "command": {"type": "string", "description": "The command line to run."}
  }}`,
		run: func(ctx context.Context, a *Agent, args json.RawMessage) (*mcp.Result, error) {
			var p struct {
				Command string `json:"command"`
			}
			if err := decode(args, &p); err != nil {
				return nil, err
			}
			win, err := a.Launch(p.Command)
			if err != nil {
				return nil, err
			}
			out := map[string]any{"result": "launched"}
			if win != nil {
				out["window"] = win
			} else {
				out["warning"] = "no window appeared on Claude's desktop yet: the app may still be starting, may have failed, or may have opened on the user's desktop"
			}
			return actionResult(ctx, a, out, nil)
		},
	},
	{
		name: "desktop_screenshot", title: "Screenshot desktop", annotations: readOnly,
		description: "Take a screenshot of this thread's target window or monitor (see desktop_open; by default Claude's desktop, empty until you start apps there with desktop_launch), scaled to at most 1280px. Its pixels are the coordinates for desktop_click and the other input tools. A window is captured even when it's hidden behind others or on another workspace. Set save=true to also save a full-resolution PNG and get its path; to show the user, put ![description](path) in your reply. The image in the tool result itself is not shown to the user.",
		schema: `{"type": "object", "properties": {
    "save": {"type": "boolean", "description": "Save a full-resolution PNG and return its path. Default false."}
  }}`,
		run: func(ctx context.Context, a *Agent, args json.RawMessage) (*mcp.Result, error) {
			var p struct {
				Save bool `json:"save"`
			}
			if err := decode(args, &p); err != nil {
				return nil, err
			}
			return shotResult(a, map[string]any{}, p.Save)
		},
	},
	{
		name: "desktop_click", title: "Click on desktop", annotations: acting,
		description: "Click at a point of this thread's target, with its desktop's mouse pointer (on the user's desktop, their own). " + coords + " Returns a screenshot of the result.",
		schema: `{"type": "object", "required": ["x", "y"], "properties": {
    "x": {"type": "number"},
    "y": {"type": "number"},
    "button": {"type": "string", "enum": ["left", "right", "middle", "back", "forward"], "description": "Default left."},
    "clickCount": {"type": "integer", "minimum": 1, "maximum": 3, "description": "2 for a double click. Default 1."},
    ` + screenshotProp + `
  }}`,
		run: func(ctx context.Context, a *Agent, args json.RawMessage) (*mcp.Result, error) {
			var p struct {
				Point
				Button     string `json:"button"`
				ClickCount int    `json:"clickCount"`
				Screenshot *bool  `json:"screenshot"`
			}
			if err := decode(args, &p); err != nil {
				return nil, err
			}
			if err := a.Click(p.Point, p.Button, p.ClickCount); err != nil {
				return nil, err
			}
			return actionResult(ctx, a, map[string]any{"result": "clicked", "at": p.Point}, p.Screenshot)
		},
	},
	{
		name: "desktop_move", title: "Move mouse on desktop", annotations: acting,
		description: "Move the mouse pointer to a point of this thread's target without clicking, e.g. to hover. " + coords,
		schema: `{"type": "object", "required": ["x", "y"], "properties": {
    "x": {"type": "number"},
    "y": {"type": "number"},
    ` + screenshotProp + `
  }}`,
		run: func(ctx context.Context, a *Agent, args json.RawMessage) (*mcp.Result, error) {
			var p struct {
				Point
				Screenshot *bool `json:"screenshot"`
			}
			if err := decode(args, &p); err != nil {
				return nil, err
			}
			if err := a.Move(p.Point); err != nil {
				return nil, err
			}
			return actionResult(ctx, a, map[string]any{"result": "moved", "at": p.Point}, p.Screenshot)
		},
	},
	{
		name: "desktop_drag", title: "Drag on desktop", annotations: acting,
		description: "Press a mouse button at one point of this thread's target, move to another and release it: drag and drop, selecting text, moving a slider. " + coords,
		schema: `{"type": "object", "required": ["fromX", "fromY", "toX", "toY"], "properties": {
    "fromX": {"type": "number"},
    "fromY": {"type": "number"},
    "toX": {"type": "number"},
    "toY": {"type": "number"},
    "button": {"type": "string", "enum": ["left", "right", "middle"], "description": "Default left."},
    ` + screenshotProp + `
  }}`,
		run: func(ctx context.Context, a *Agent, args json.RawMessage) (*mcp.Result, error) {
			var p struct {
				FromX, FromY, ToX, ToY float64
				Button                 string `json:"button"`
				Screenshot             *bool  `json:"screenshot"`
			}
			if err := decode(args, &p); err != nil {
				return nil, err
			}
			from, to := Point{p.FromX, p.FromY}, Point{p.ToX, p.ToY}
			if err := a.Drag(from, to, p.Button); err != nil {
				return nil, err
			}
			return actionResult(ctx, a, map[string]any{"result": "dragged", "from": from, "to": to}, p.Screenshot)
		},
	},
	{
		name: "desktop_scroll", title: "Scroll on desktop", annotations: acting,
		description: "Turn the mouse wheel over a point of this thread's target: dy notches down (negative: up), dx notches right (negative: left). A notch is usually about three lines. " + coords,
		schema: `{"type": "object", "required": ["x", "y"], "properties": {
    "x": {"type": "number"},
    "y": {"type": "number"},
    "dy": {"type": "number", "description": "Notches down; negative scrolls up."},
    "dx": {"type": "number", "description": "Notches right; negative scrolls left."},
    ` + screenshotProp + `
  }}`,
		run: func(ctx context.Context, a *Agent, args json.RawMessage) (*mcp.Result, error) {
			var p struct {
				Point
				DX, DY     float64
				Screenshot *bool `json:"screenshot"`
			}
			if err := decode(args, &p); err != nil {
				return nil, err
			}
			if p.DX == 0 && p.DY == 0 {
				return nil, errors.New("give dy or dx")
			}
			if err := a.Scroll(p.Point, p.DX, p.DY); err != nil {
				return nil, err
			}
			return actionResult(ctx, a, map[string]any{"result": "scrolled", "at": p.Point}, p.Screenshot)
		},
	},
	{
		name: "desktop_type", title: "Type on desktop", annotations: acting,
		description: "Type text into whatever has keyboard focus in this thread's target (a window target is focused first), as key presses on the computer's keyboard layout. Newlines press Enter and tabs press Tab. It stops at a character the layout has no key for; paste such text with desktop_clipboard and desktop_press instead. Click a field first to focus it.",
		schema: `{"type": "object", "required": ["text"], "properties": {
    "text": {"type": "string"},
    ` + screenshotProp + `
  }}`,
		run: func(ctx context.Context, a *Agent, args json.RawMessage) (*mcp.Result, error) {
			var p struct {
				Text       string `json:"text"`
				Screenshot *bool  `json:"screenshot"`
			}
			if err := decode(args, &p); err != nil {
				return nil, err
			}
			n, err := a.Type(p.Text)
			if err != nil {
				return nil, err
			}
			return actionResult(ctx, a, map[string]any{"result": fmt.Sprintf("typed %d characters", n)}, p.Screenshot)
		},
	},
	{
		name: "desktop_press", title: "Press keys on desktop", annotations: acting,
		description: "Press a key or key combination in this thread's target (a window target is focused first), like \"enter\", \"ctrl+c\", \"ctrl+shift+t\", \"alt+tab\" or \"super+2\". Names: ctrl, shift, alt, altgr, super, enter, esc, tab, space, backspace, delete, insert, home, end, pageup, pagedown, up, down, left, right, f1-f24, printscreen, menu, capslock, volumeup, volumedown, mute, playpause, letters, digits and US-layout punctuation (keys are pressed by position). Super combinations are the desktop's own shortcuts (switching workspaces, launching apps), not the target window's.",
		schema: `{"type": "object", "required": ["keys"], "properties": {
    "keys": {"type": "string", "description": "Keys joined by +, e.g. ctrl+shift+t."},
    "times": {"type": "integer", "minimum": 1, "maximum": 50, "description": "Press it this many times. Default 1."},
    ` + screenshotProp + `
  }}`,
		run: func(ctx context.Context, a *Agent, args json.RawMessage) (*mcp.Result, error) {
			var p struct {
				Keys       string `json:"keys"`
				Times      int    `json:"times"`
				Screenshot *bool  `json:"screenshot"`
			}
			if err := decode(args, &p); err != nil {
				return nil, err
			}
			if err := a.Press(p.Keys, p.Times); err != nil {
				return nil, err
			}
			return actionResult(ctx, a, map[string]any{"result": "pressed " + p.Keys}, p.Screenshot)
		},
	},
	{
		name: "desktop_focus", title: "Focus desktop window", annotations: acting,
		description: "Bring a window (by id from desktop_list) to the front with keyboard focus, or show a workspace (by number). It doesn't change this thread's target; use desktop_open for that.",
		schema: `{"type": "object", "properties": {
    "window": {"type": "string", "description": "Window id from desktop_list."},
    "workspace": {"type": "integer", "minimum": 1, "description": "Workspace number."}
  }}`,
		run: func(ctx context.Context, a *Agent, args json.RawMessage) (*mcp.Result, error) {
			var p struct {
				Window    string `json:"window"`
				Workspace int    `json:"workspace"`
			}
			if err := decode(args, &p); err != nil {
				return nil, err
			}
			var err error
			switch {
			case p.Window != "" && p.Workspace != 0:
				return nil, errors.New("give window or workspace, not both")
			case p.Window != "":
				err = a.FocusWindow(p.Window)
			case p.Workspace != 0:
				err = a.FocusWorkspace(p.Workspace)
			default:
				return nil, errors.New("give window or workspace")
			}
			if err != nil {
				return nil, err
			}
			return mcp.Text("focused"), nil
		},
	},
	{
		name: "desktop_clipboard", title: "Desktop clipboard", annotations: acting,
		description: "Read the clipboard text of the desktop this thread works on, or with text, replace it (then paste with desktop_press, e.g. ctrl+v, or ctrl+shift+v in a terminal). Use it for text desktop_type can't type, or long text.",
		schema: `{"type": "object", "properties": {
    "text": {"type": "string", "description": "Put this on the clipboard. Leave it out to read the clipboard."}
  }}`,
		run: func(ctx context.Context, a *Agent, args json.RawMessage) (*mcp.Result, error) {
			var p struct {
				Text *string `json:"text"`
			}
			if err := decode(args, &p); err != nil {
				return nil, err
			}
			if p.Text != nil {
				if err := a.SetClipboard(*p.Text); err != nil {
					return nil, err
				}
				return mcp.Text("copied to the clipboard"), nil
			}
			text, err := a.Clipboard()
			if err != nil {
				return nil, err
			}
			return mcp.Text(text), nil
		},
	},
}

// actionResult reports an action and, unless screenshot is false, how the
// target looks after it.
func actionResult(ctx context.Context, a *Agent, out map[string]any, screenshot *bool) (*mcp.Result, error) {
	if screenshot != nil && !*screenshot {
		return mcp.JSON(out)
	}
	select {
	case <-time.After(settle):
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return shotResult(a, out, false)
}

// shotResult adds a screenshot of the target to out.
func shotResult(a *Agent, out map[string]any, save bool) (*mcp.Result, error) {
	shot, err := a.Screenshot(save)
	if err != nil {
		if len(out) == 0 {
			return nil, err
		}
		out["warning"] = "couldn't take a screenshot: " + err.Error()
		return mcp.JSON(out)
	}
	out["target"] = shot.View.Target
	out["screenshot"] = map[string]int{"width": shot.View.Width, "height": shot.View.Height}
	if shot.Path != "" {
		out["path"] = shot.Path
	}
	res, err := mcp.JSON(out)
	if err != nil {
		return nil, err
	}
	return res.Image(shot.JPEG, "image/jpeg"), nil
}

func decode(args json.RawMessage, out any) error {
	if len(args) == 0 {
		return nil
	}
	if err := json.Unmarshal(args, out); err != nil {
		return fmt.Errorf("invalid arguments: %w", err)
	}
	return nil
}
