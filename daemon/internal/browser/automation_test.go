package browser

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

const automationPage = `<!doctype html>
<title>form</title>
<style>body{margin:0;font:16px sans-serif} #list{height:100px;overflow:auto} #list div{height:40px}</style>
<h1>Sign up</h1>
<form onsubmit="event.preventDefault(); document.title='submitted:'+document.getElementById('name').value">
  <label>Name <input id=name placeholder="Your name"></label>
  <button type=button onclick="setTimeout(()=>{const p=document.createElement('p');p.id='later';p.textContent='Saved!';document.body.append(p)},300)">Save</button>
  <button type=button>Cancel</button>
  <button type=button>Cancel</button>
</form>
<div id=list>` + "<div>1</div><div>2</div><div>3</div><div>4</div><div>5</div><div>6</div>" + `</div>
<div id=keys></div>
<script>
  console.log("hello", 42);
  console.error("bad thing");
  fetch("/missing");
  addEventListener("keydown", (e) => { document.getElementById("keys").textContent += e.key + (e.ctrlKey ? "^" : "") + ","; });
</script>`

type mcpClient struct {
	t     *testing.T
	url   string
	token string
	id    int
}

func (c *mcpClient) call(name string, args any) (text string, images []mcp.Content, isError bool) {
	c.t.Helper()
	c.id++
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": c.id, "method": "tools/call",
		"params": map[string]any{"name": name, "arguments": args},
	})
	req, _ := http.NewRequest(http.MethodPost, c.url+mcp.Path, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var r struct {
		Result mcp.Result `json:"result"`
		Error  any        `json:"error"`
	}
	if err := json.Unmarshal(raw, &r); err != nil || r.Error != nil {
		c.t.Fatalf("%s: %s", name, raw)
	}
	for _, b := range r.Result.Content {
		if b.Type == "text" {
			text += b.Text
		} else {
			images = append(images, b)
		}
	}
	return text, images, r.Result.IsError
}

// ok calls a tool that must succeed and decodes its JSON text into out.
func (c *mcpClient) ok(name string, args any, out any) {
	c.t.Helper()
	text, _, isErr := c.call(name, args)
	if isErr {
		c.t.Fatalf("%s(%v) failed: %s", name, args, text)
	}
	if out != nil {
		if err := json.Unmarshal([]byte(text), out); err != nil {
			c.t.Fatalf("%s: %v in %s", name, err, text)
		}
	}
}

func (c *mcpClient) fails(name string, args any, want string) {
	c.t.Helper()
	text, _, isErr := c.call(name, args)
	if !isErr || !strings.Contains(text, want) {
		c.t.Fatalf("%s(%v) = %q (error %v), want an error containing %q", name, args, text, isErr, want)
	}
}

func TestAutomationTools(t *testing.T) {
	if _, err := findChrome(context.Background()); errors.Is(err, ErrNotInstalled) {
		t.Skip(err)
	}
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(automationPage))
	}))
	defer site.Close()

	m := NewManager(t.TempDir())
	defer m.Shutdown()
	srv := mcp.NewServer("everywhere", "test", Tools(m))
	hs := httptest.NewServer(srv)
	defer hs.Close()
	c := &mcpClient{t: t, url: hs.URL, token: srv.AddToken(mcp.Caller{ThreadID: "th", Browser: "p"})}

	// A viewer sees what the agent does.
	v := newFakeViewer()
	if err := m.Attach(context.Background(), "p", v, Viewport{Width: 1600, Height: 1000, DPR: 2}); err != nil {
		t.Fatal(err)
	}
	defer m.Detach("p", v)

	var st status
	c.ok("browser_navigate", map[string]any{"url": site.URL}, &st)
	if st.Title != "form" || st.URL != site.URL+"/" || !st.Watched {
		t.Fatalf("navigate: %+v", st)
	}

	var snap struct {
		PageSnapshot
		ScreenshotPath string `json:"screenshotPath"`
	}
	text, imgs, _ := c.call("browser_snapshot", map[string]any{"save": true})
	if err := json.Unmarshal([]byte(text), &snap); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(snap.Text, "Sign up") || len(snap.Elements) < 5 {
		t.Fatalf("snapshot: %s", text)
	}
	var sawInput bool
	for _, e := range snap.Elements {
		sawInput = sawInput || (e.Selector == "#name" && e.Role == "textbox" && e.Name == "Your name")
	}
	if !sawInput {
		t.Fatalf("no #name textbox in %+v", snap.Elements)
	}
	c.ok("browser_wait_for", map[string]any{"text": "Sign up"}, nil) // let the fetch fail meanwhile
	if !hasConsole(snap.Console, "log", "hello 42") || !hasConsole(snap.Console, "error", "bad thing") {
		// Console entries can land just after the snapshot; look again.
		c.ok("browser_snapshot", map[string]any{"includeImage": false}, &snap)
	}
	if !hasConsole(snap.Console, "log", "hello 42") || !hasConsole(snap.Console, "error", "bad thing") {
		t.Fatalf("console: %+v", snap.Console)
	}
	if len(imgs) != 1 || imgs[0].MIMEType != "image/jpeg" {
		t.Fatalf("images: %+v", imgs)
	}
	jpeg, _ := base64.StdEncoding.DecodeString(imgs[0].Data)
	cfg, _, err := image.DecodeConfig(bytes.NewReader(jpeg))
	if err != nil || max(cfg.Width, cfg.Height) > 1280 || cfg.Width < 1000 {
		t.Fatalf("screenshot %dx%d, %v; want the longest side at most 1280", cfg.Width, cfg.Height, err)
	}
	if png, err := os.ReadFile(snap.ScreenshotPath); err != nil || !bytes.HasPrefix(png, []byte("\x89PNG")) {
		t.Fatalf("saved screenshot %q: %v", snap.ScreenshotPath, err)
	}

	c.ok("browser_snapshot", map[string]any{"includeImage": false}, &snap)
	var saw404 bool
	for _, n := range snap.Network {
		saw404 = saw404 || (n.Status == 404 && strings.HasSuffix(n.URL, "/missing") && n.Method == "GET")
	}
	if !saw404 {
		t.Fatalf("failed requests: %+v", snap.Network)
	}

	// Click by text, then wait for what it adds.
	var clicked struct {
		Element PageElement `json:"element"`
	}
	c.ok("browser_click", map[string]any{"text": "save"}, &clicked)
	if clicked.Element.Tag != "button" {
		t.Fatalf("clicked %+v", clicked.Element)
	}
	c.ok("browser_wait_for", map[string]any{"selector": "#later", "text": "Saved!", "timeoutMs": 5000}, nil)
	c.fails("browser_wait_for", map[string]any{"selector": "#never", "timeoutMs": 300}, "selector")
	c.fails("browser_click", map[string]any{"text": "Cancel"}, "matches 2 visible elements")
	c.fails("browser_click", map[string]any{"selector": "#nope"}, "no element matches")

	// Type into a field found by its placeholder, replace it, and submit.
	c.ok("browser_type", map[string]any{"target": "Your name", "text": "Ada"}, nil)
	c.ok("browser_type", map[string]any{"selector": "#name", "text": "Grace", "clear": true, "submit": true}, nil)
	c.ok("browser_wait_for", map[string]any{"text": "Saved!"}, nil)
	var val struct {
		Value any `json:"value"`
	}
	c.ok("browser_evaluate", map[string]any{"expression": "document.title"}, &val)
	if val.Value != "submitted:Grace" {
		t.Fatalf("title after submit = %v", val.Value)
	}

	// Keys go to the page with their modifiers.
	c.ok("browser_evaluate", map[string]any{"expression": "document.activeElement.blur(); document.getElementById('keys').textContent = ''"}, nil)
	c.ok("browser_press", map[string]any{"key": "Escape"}, nil)
	c.ok("browser_press", map[string]any{"key": "a", "modifiers": []string{"Control"}}, nil)
	c.ok("browser_press", map[string]any{"key": "ArrowDown"}, nil)
	c.ok("browser_evaluate", map[string]any{"expression": "document.getElementById('keys').textContent"}, &val)
	if val.Value != "Escape,a^,ArrowDown," {
		t.Fatalf("keys = %v", val.Value)
	}

	// Scrolling a container moves it, not the page.
	var sc ScrollResult
	c.ok("browser_scroll", map[string]any{"selector": "#list", "deltaY": 80}, &sc)
	if sc.After.Y <= sc.Before.Y {
		t.Fatalf("scroll: %+v", sc)
	}

	c.ok("browser_evaluate", map[string]any{"expression": "await new Promise(r => setTimeout(() => r({n: 1}), 50))"}, &val)
	if m, _ := val.Value.(map[string]any); m["n"] != float64(1) {
		t.Fatalf("awaited value = %v", val.Value)
	}
	c.fails("browser_evaluate", map[string]any{"expression": "throw new Error('nope')"}, "nope")
	c.fails("browser_evaluate", map[string]any{"expression": "'x'.repeat(70000)"}, "64 KB")

	// Resize and appearance change the tab's state, as the viewer sees it.
	var rs struct {
		Viewport protocol.BrowserViewportSetting `json:"viewport"`
	}
	c.ok("browser_resize", map[string]any{"mode": "preset", "preset": "iphone-se", "orientation": "landscape"}, &rs)
	if rs.Viewport.Width != 667 || rs.Viewport.Height != 375 || !rs.Viewport.Mobile {
		t.Fatalf("resize: %+v", rs.Viewport)
	}
	c.fails("browser_resize", map[string]any{"mode": "preset", "preset": "nokia"}, "unknown viewport preset")
	c.ok("browser_set_appearance", map[string]any{"colorScheme": "dark"}, nil)
	c.ok("browser_evaluate", map[string]any{"expression": "matchMedia('(prefers-color-scheme: dark)').matches"}, &val)
	if val.Value != true {
		t.Fatal("dark mode not emulated")
	}
	c.ok("browser_status", nil, &st)
	if st.ColorScheme != "dark" || st.Viewport == nil {
		t.Fatalf("status: %+v", st)
	}

	// Viewers heard about the agent's clicks, with positions.
	v.mu.Lock()
	var sawAgentClick bool
	for _, msg := range v.msgs {
		if a, ok := msg.(protocol.BrowserAgent); ok && a.Action == "click" && a.X > 0 && a.Y > 0 {
			sawAgentClick = true
		}
	}
	v.mu.Unlock()
	if !sawAgentClick {
		t.Fatal("viewer saw no agent click")
	}

	c.ok("browser_snapshot", map[string]any{"includeImage": false}, &snap)
	if len(snap.Actions) < 10 {
		t.Fatalf("actions: %+v", snap.Actions)
	}
	c.fails("browser_navigate", map[string]any{"port": 1}, "port 1")
}

func hasConsole(entries []ConsoleEntry, level, text string) bool {
	for _, e := range entries {
		if e.Level == level && e.Text == text {
			return true
		}
	}
	return false
}

func TestNavigateURL(t *testing.T) {
	for _, c := range []struct {
		url  string
		port int
		path string
		want string
	}{
		{"localhost:5173/x", 0, "", "http://localhost:5173/x"},
		{"127.0.0.1:8080", 0, "", "http://127.0.0.1:8080"},
		{"example.com", 0, "", "https://example.com"},
		{"https://example.com/a?b#c", 0, "", "https://example.com/a?b#c"},
		{"", 3000, "settings?tab=1", "http://localhost:3000/settings?tab=1"},
		{"", 3000, "", "http://localhost:3000"},
	} {
		got, err := NavigateURL(c.url, c.port, c.path)
		if err != nil || got != c.want {
			t.Errorf("NavigateURL(%q, %d, %q) = %q, %v; want %q", c.url, c.port, c.path, got, err, c.want)
		}
	}
	if _, err := NavigateURL("file:///etc/passwd", 0, ""); err == nil {
		t.Error("file URL allowed")
	}
}

func TestLookupKey(t *testing.T) {
	for key, want := range map[string]keyDef{
		"Enter": {"Enter", "Enter", "\r", 13, 0},
		"esc":   namedKeys["Escape"],
		"a":     {"a", "KeyA", "a", 65, 0},
		"7":     {"7", "Digit7", "7", 55, 0},
		"F5":    {"F5", "F5", "", 116, 0},
		"Space": {" ", "Space", " ", 32, 0},
	} {
		got, err := lookupKey(key, false)
		if err != nil || got != want {
			t.Errorf("lookupKey(%q) = %+v, %v; want %+v", key, got, err, want)
		}
	}
	if k, _ := lookupKey("a", true); k.text != "A" {
		t.Errorf("shift+a types %q", k.text)
	}
	if _, err := lookupKey("Hyper", false); err == nil {
		t.Error("unknown key accepted")
	}
}

func TestDiagnosticsRing(t *testing.T) {
	var d diagnostics
	for i := range 250 {
		d.note("Runtime.consoleAPICalled", json.RawMessage(`{"type":"log","args":[{"type":"number","value":`+itoa(i)+`,"description":"`+itoa(i)+`"}],"timestamp":1700000000000}`))
	}
	d.note("Network.requestWillBeSent", json.RawMessage(`{"requestId":"1","request":{"url":"http://x/a","method":"POST"}}`))
	d.note("Network.loadingFailed", json.RawMessage(`{"requestId":"1","type":"Fetch","errorText":"net::ERR_CONNECTION_REFUSED"}`))
	d.note("Network.requestWillBeSent", json.RawMessage(`{"requestId":"2","request":{"url":"http://x/b","method":"GET"}}`))
	d.note("Network.loadingFailed", json.RawMessage(`{"requestId":"2","errorText":"net::ERR_ABORTED","canceled":true}`))
	tab := &Tab{}
	tab.diag.console, tab.diag.network = d.console, d.network
	console, network, _ := tab.Diagnostics(3)
	if len(console) != 3 || console[0].Text != "247" || console[2].Text != "249" {
		t.Fatalf("console = %+v", console)
	}
	if all, _, _ := tab.Diagnostics(-1); len(all) != diagKeep || all[0].Text != "50" {
		t.Fatalf("kept %d, oldest %q", len(all), all[0].Text)
	}
	if len(network) != 1 || network[0].Method != "POST" || network[0].ErrorText != "net::ERR_CONNECTION_REFUSED" {
		t.Fatalf("network = %+v", network)
	}
}

func itoa(i int) string {
	b, _ := json.Marshal(i)
	return string(b)
}
