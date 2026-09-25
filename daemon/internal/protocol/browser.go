package protocol

import "encoding/json"

// ---------------------------------------------------------------------------
// Browser channel browser:<threadId>: a thread's Chromium tab on the device.
// JSON text frames both ways. A viewer that attaches with video gets the tab
// as WebRTC video on a peer connection of its own, from the device's
// Chromium, signaled over this channel (offer, answer, ice). Otherwise, or
// after novideo, it gets a JPEG screencast: each daemon "frame" header is
// followed by the JPEG as binary chunks totalling Size bytes.
// ---------------------------------------------------------------------------

const BrowserChannelPrefix = "browser:"

// BrowserClientMsg is a frame from the browser, discriminated by T:
//   - attach {width, height, dpr, quality, mobile, video}: must come first;
//     the client's view size in CSS pixels, dpr 1-2, quality 20-95, whether
//     it's a touch device, and whether it wants video. The last client to
//     attach or resize sets the tab's size while its viewport mode is "fill".
//   - resize {width, height, dpr, quality, mobile}
//   - offer {sdp}: a video viewer's offer (receive-only video); answered
//     with answer {sdp}, or novideo if the tab falls back to JPEG. Sending
//     another replaces the viewer's peer connection.
//   - ice {candidate}: a trickled candidate (RTCIceCandidateInit) for it
//   - viewport {mode, preset, orientation, width, height}: fill the viewers'
//     view (mode "fill"), emulate a device (mode "preset", preset id and
//     orientation portrait|landscape), or a fixed size (mode "freeform")
//   - appearance {colorScheme}: light | dark | "" for the system's
//   - navigate {url}: http, https or about:blank
//   - back, forward, reload, stop
//   - mouse {kind: move|down|up|wheel, x, y, button, buttons, clickCount,
//     deltaX, deltaY, modifiers}: x/y in CSS pixels of the viewport; button
//     and buttons as in DOM MouseEvent
//   - key {kind: down|up, key, code, keyCode, text, location, repeat,
//     modifiers}: text is set for keys that insert it
//   - text {text}: inserts text as if typed (IME, paste, soft keyboards)
//   - copy: answers with clipboard {text}, the page's current selection
//   - touch {kind: start|move|end|cancel, points, modifiers}: points are the
//     touches still down (for end, the ones that stay down)
//   - pick {id, x, y}: answers with picked {id, element}, the element at x/y
//     (null if none), for annotations
//
// Modifiers is a bitmask: Alt 1, Control 2, Meta 4, Shift 8.
type BrowserClientMsg struct {
	T          string  `json:"t"`
	Width      int     `json:"width,omitempty"`
	Height     int     `json:"height,omitempty"`
	DPR        float64 `json:"dpr,omitempty"`
	Quality    int     `json:"quality,omitempty"`
	URL        string  `json:"url,omitempty"`
	Kind       string  `json:"kind,omitempty"`
	X          float64 `json:"x,omitempty"`
	Y          float64 `json:"y,omitempty"`
	Button     int     `json:"button,omitempty"`
	Buttons    int     `json:"buttons,omitempty"`
	ClickCount int     `json:"clickCount,omitempty"`
	DeltaX     float64 `json:"deltaX,omitempty"`
	DeltaY     float64 `json:"deltaY,omitempty"`
	Modifiers  int     `json:"modifiers,omitempty"`
	Key        string  `json:"key,omitempty"`
	Code       string  `json:"code,omitempty"`
	KeyCode    int     `json:"keyCode,omitempty"`
	Text       string  `json:"text,omitempty"`
	Location   int     `json:"location,omitempty"`
	Repeat     bool    `json:"repeat,omitempty"`
	Video      bool    `json:"video,omitempty"`
	SDP        string  `json:"sdp,omitempty"`
	// Candidate is an RTCIceCandidateInit, passed through as is.
	Candidate json.RawMessage `json:"candidate,omitempty"`

	Mobile      bool                `json:"mobile,omitempty"`
	Mode        string              `json:"mode,omitempty"`
	Preset      string              `json:"preset,omitempty"`
	Orientation string              `json:"orientation,omitempty"`
	ColorScheme string              `json:"colorScheme,omitempty"`
	Points      []BrowserTouchPoint `json:"points,omitempty"`
	ID          int                 `json:"id,omitempty"`
}

type BrowserTouchPoint struct {
	ID int     `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
}

// BrowserViewportSetting is how a tab's viewport is sized.
type BrowserViewportSetting struct {
	Mode   string `json:"mode"`             // fill | preset | freeform
	Preset string `json:"preset,omitempty"` // preset id, for mode preset
	// Width and Height are the emulated size in CSS pixels; for fill, the
	// viewer's.
	Width  int  `json:"width"`
	Height int  `json:"height"`
	Mobile bool `json:"mobile"` // touch and mobile layout rules
}

// BrowserElement describes a page element, for annotations and agent tools.
type BrowserElement struct {
	Tag       string            `json:"tag"`
	ID        string            `json:"id,omitempty"`
	Classes   []string          `json:"classes,omitempty"`
	Selector  string            `json:"selector"`
	Role      string            `json:"role,omitempty"`
	Name      string            `json:"name,omitempty"` // accessible name, or text
	Text      string            `json:"text,omitempty"`
	Attrs     map[string]string `json:"attrs,omitempty"`
	Component string            `json:"component,omitempty"` // React component chain, innermost first
	Source    string            `json:"source,omitempty"`    // file:line, when React exposes it
	Styles    map[string]string `json:"styles,omitempty"`
	// Rect in CSS pixels of the viewport.
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// Frames from the daemon, discriminated by T.
type (
	// BrowserFrame precedes a JPEG of Size bytes. Width and Height are the
	// viewport in CSS pixels that the image covers.
	BrowserFrame struct {
		T      string `json:"t"` // "frame"
		Seq    int64  `json:"seq"`
		Size   int    `json:"size"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	}

	BrowserState struct {
		T            string `json:"t"` // "state"
		URL          string `json:"url"`
		Title        string `json:"title"`
		Loading      bool   `json:"loading"`
		CanGoBack    bool   `json:"canGoBack"`
		CanGoForward bool   `json:"canGoForward"`
		// ColorScheme is the emulated prefers-color-scheme, "" for none.
		ColorScheme string                 `json:"colorScheme"`
		Viewport    BrowserViewportSetting `json:"viewport"`
		// Editing is whether a text field in the page has focus, so touch
		// clients can offer their keyboard.
		Editing bool `json:"editing"`
	}

	// BrowserPicked answers pick.
	BrowserPicked struct {
		T       string          `json:"t"` // "picked"
		ID      int             `json:"id"`
		Element *BrowserElement `json:"element"`
	}

	// BrowserAgent shows what an agent is doing in the tab: Action is
	// click | type | press | scroll | navigate | ..., at X/Y when it has a
	// position.
	BrowserAgent struct {
		T      string  `json:"t"` // "agent"
		Action string  `json:"action"`
		X      float64 `json:"x,omitempty"`
		Y      float64 `json:"y,omitempty"`
		Label  string  `json:"label,omitempty"`
	}

	// BrowserCursor is the CSS cursor under the pointer.
	BrowserCursor struct {
		T      string `json:"t"` // "cursor"
		Cursor string `json:"cursor"`
	}

	BrowserClipboard struct {
		T    string `json:"t"` // "clipboard"
		Text string `json:"text"`
	}

	// BrowserNotice reports something the page did that the stream can't
	// show, like a dialog that was answered automatically.
	BrowserNotice struct {
		T       string `json:"t"` // "notice"
		Message string `json:"message"`
	}

	// BrowserAnswer answers a video viewer's offer.
	BrowserAnswer struct {
		T   string `json:"t"` // "answer"
		SDP string `json:"sdp"`
	}

	// BrowserICE is one of the device's trickled candidates for a viewer's
	// video; it can arrive before the answer.
	BrowserICE struct {
		T         string          `json:"t"` // "ice"
		Candidate json.RawMessage `json:"candidate"`
	}

	// BrowserNoVideo moves a viewer to JPEG frames.
	BrowserNoVideo struct {
		T       string `json:"t"` // "novideo"
		Message string `json:"message"`
	}

	BrowserError struct {
		T       string `json:"t"` // "error"
		Message string `json:"message"`
	}
)
