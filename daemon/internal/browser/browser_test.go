package browser

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

type fakeViewer struct {
	mu     sync.Mutex
	frames []protocol.BrowserFrame
	msgs   []any
	closed string
	notify chan struct{}
}

func newFakeViewer() *fakeViewer { return &fakeViewer{notify: make(chan struct{}, 1)} }

func (v *fakeViewer) Frame(hdr protocol.BrowserFrame, jpeg []byte) {
	v.mu.Lock()
	if len(jpeg) < 2 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
		hdr.Size = -1 // not a JPEG
	}
	v.frames = append(v.frames, hdr)
	v.mu.Unlock()
	v.poke()
}

func (v *fakeViewer) Send(msg any) {
	v.mu.Lock()
	v.msgs = append(v.msgs, msg)
	v.mu.Unlock()
	v.poke()
}

func (v *fakeViewer) Buffered() uint64 { return 0 }

func (v *fakeViewer) Closed(reason string) {
	v.mu.Lock()
	v.closed = reason
	v.mu.Unlock()
	v.poke()
}

func (v *fakeViewer) poke() {
	select {
	case v.notify <- struct{}{}:
	default:
	}
}

// waitFor polls cond each time the viewer hears something.
func (v *fakeViewer) waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		v.mu.Lock()
		ok := cond()
		v.mu.Unlock()
		if ok {
			return
		}
		select {
		case <-v.notify:
		case <-time.After(50 * time.Millisecond):
		case <-deadline:
			v.mu.Lock()
			defer v.mu.Unlock()
			t.Fatalf("timed out waiting for %s (last state %+v)", what, v.lastState())
		}
	}
}

func (v *fakeViewer) lastState() protocol.BrowserState {
	for i := len(v.msgs) - 1; i >= 0; i-- {
		if s, ok := v.msgs[i].(protocol.BrowserState); ok {
			return s
		}
	}
	return protocol.BrowserState{}
}

const testPage = `<!doctype html>
<title>start</title>
<style>body{margin:0} #b{position:absolute;left:0;top:0;width:200px;height:100px;cursor:pointer}
#i{position:absolute;left:0;top:200px;width:300px;height:40px}</style>
<button id=b onclick="document.title='clicked'">click</button>
<input id=i oninput="document.title='typed:'+this.value">`

func TestBrowserEndToEnd(t *testing.T) {
	if _, err := findChrome(context.Background()); errors.Is(err, ErrNotInstalled) {
		t.Skip(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(testPage))
	}))
	defer srv.Close()

	m := NewManager(t.TempDir())
	defer m.Shutdown()
	v := newFakeViewer()
	if err := m.Attach(context.Background(), "p1", v, Viewport{Width: 800, Height: 600}); err != nil {
		t.Fatal(err)
	}
	defer m.Detach("p1", v)

	m.Handle("p1", v, protocol.BrowserClientMsg{T: "navigate", URL: srv.URL})
	v.waitFor(t, "page title", func() bool { return v.lastState().Title == "start" })
	v.waitFor(t, "a frame", func() bool { return len(v.frames) > 0 })
	f := v.frames[len(v.frames)-1]
	if f.Size <= 0 || f.Width != 800 || f.Height != 600 {
		t.Fatalf("frame = %+v, want an 800x600 JPEG", f)
	}

	// Hovering the button reports its cursor; clicking it runs its handler.
	m.Handle("p1", v, protocol.BrowserClientMsg{T: "mouse", Kind: "move", X: 50, Y: 50})
	v.waitFor(t, "pointer cursor", func() bool {
		for _, msg := range v.msgs {
			if c, ok := msg.(protocol.BrowserCursor); ok && c.Cursor == "pointer" {
				return true
			}
		}
		return false
	})
	m.Handle("p1", v, protocol.BrowserClientMsg{T: "mouse", Kind: "down", X: 50, Y: 50, Buttons: 1, ClickCount: 1})
	m.Handle("p1", v, protocol.BrowserClientMsg{T: "mouse", Kind: "up", X: 50, Y: 50, ClickCount: 1})
	v.waitFor(t, "click", func() bool { return v.lastState().Title == "clicked" })

	// Focus the input, type with key events and inserted text, then select
	// all with Ctrl+A and copy.
	m.Handle("p1", v, protocol.BrowserClientMsg{T: "mouse", Kind: "down", X: 20, Y: 220, Buttons: 1, ClickCount: 1})
	m.Handle("p1", v, protocol.BrowserClientMsg{T: "mouse", Kind: "up", X: 20, Y: 220, ClickCount: 1})
	for _, k := range []protocol.BrowserClientMsg{
		{T: "key", Kind: "down", Key: "h", Code: "KeyH", KeyCode: 72, Text: "h"},
		{T: "key", Kind: "up", Key: "h", Code: "KeyH", KeyCode: 72},
		{T: "key", Kind: "down", Key: "i", Code: "KeyI", KeyCode: 73, Text: "i"},
		{T: "key", Kind: "up", Key: "i", Code: "KeyI", KeyCode: 73},
		{T: "text", Text: "!✓"},
		{T: "key", Kind: "down", Key: "Backspace", Code: "Backspace", KeyCode: 8},
		{T: "key", Kind: "up", Key: "Backspace", Code: "Backspace", KeyCode: 8},
	} {
		m.Handle("p1", v, k)
	}
	v.waitFor(t, "typing", func() bool { return v.lastState().Title == "typed:hi!" })

	m.Handle("p1", v, protocol.BrowserClientMsg{T: "key", Kind: "down", Key: "a", Code: "KeyA", KeyCode: 65, Modifiers: 2})
	m.Handle("p1", v, protocol.BrowserClientMsg{T: "key", Kind: "up", Key: "a", Code: "KeyA", KeyCode: 65, Modifiers: 2})
	m.Handle("p1", v, protocol.BrowserClientMsg{T: "copy"})
	v.waitFor(t, "clipboard", func() bool {
		for _, msg := range v.msgs {
			if c, ok := msg.(protocol.BrowserClipboard); ok && c.Text == "hi!" {
				return true
			}
		}
		return false
	})

	// A second viewer gets the current frame without the page changing.
	v2 := newFakeViewer()
	if err := m.Attach(context.Background(), "p1", v2, Viewport{Width: 800, Height: 600}); err != nil {
		t.Fatal(err)
	}
	v2.waitFor(t, "catch-up frame", func() bool { return len(v2.frames) > 0 })
	m.Detach("p1", v2)
}

// stuckViewer never drains, like a peer whose connection has died but
// hasn't been noticed yet.
type stuckViewer struct{ *fakeViewer }

func (stuckViewer) Buffered() uint64 { return 64 << 20 }

func TestStuckViewerDoesNotStallOthers(t *testing.T) {
	if _, err := findChrome(context.Background()); errors.Is(err, ErrNotInstalled) {
		t.Skip(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<style>@keyframes m{to{margin-left:300px}}div{width:50px;height:50px;background:red;animation:m 1s linear infinite alternate}</style><div></div>`))
	}))
	defer srv.Close()

	m := NewManager(t.TempDir())
	defer m.Shutdown()
	stuck := stuckViewer{newFakeViewer()}
	if err := m.Attach(context.Background(), "p", stuck, Viewport{Width: 400, Height: 300}); err != nil {
		t.Fatal(err)
	}
	v := newFakeViewer()
	if err := m.Attach(context.Background(), "p", v, Viewport{Width: 400, Height: 300}); err != nil {
		t.Fatal(err)
	}
	m.Handle("p", v, protocol.BrowserClientMsg{T: "navigate", URL: srv.URL})
	v.waitFor(t, "first frame", func() bool { return len(v.frames) > 0 })
	time.Sleep(500 * time.Millisecond)
	v.mu.Lock()
	before := len(v.frames)
	v.mu.Unlock()
	time.Sleep(time.Second)
	v.mu.Lock()
	got := len(v.frames) - before
	v.mu.Unlock()
	if got < 15 {
		t.Fatalf("healthy viewer got %d frames in a second next to a stuck one", got)
	}
}
