package protocol

// ---------------------------------------------------------------------------
// Browser channel browser:<projectId>: a Chromium tab on the device, shown as
// a JPEG screencast. JSON text frames both ways; each daemon "frame" header
// is followed by the JPEG as binary chunks totalling Size bytes.
// ---------------------------------------------------------------------------

const BrowserChannelPrefix = "browser:"

// BrowserClientMsg is a frame from the browser, discriminated by T:
//   - attach {width, height, dpr, quality}: must come first; the viewport in
//     CSS pixels, dpr 1-2, quality 20-95. The last client to attach or resize
//     sets the tab's size.
//   - resize {width, height, dpr, quality}
//   - navigate {url}: http, https or about:blank
//   - back, forward, reload, stop
//   - mouse {kind: move|down|up|wheel, x, y, button, buttons, clickCount,
//     deltaX, deltaY, modifiers}: x/y in CSS pixels of the viewport; button
//     and buttons as in DOM MouseEvent
//   - key {kind: down|up, key, code, keyCode, text, location, repeat,
//     modifiers}: text is set for keys that insert it
//   - text {text}: inserts text as if typed (IME, paste, soft keyboards)
//   - copy: answers with clipboard {text}, the page's current selection
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

	BrowserError struct {
		T       string `json:"t"` // "error"
		Message string `json:"message"`
	}
)
