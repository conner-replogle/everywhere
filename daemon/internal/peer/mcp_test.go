package peer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/browser"
	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

// mcpTestServer returns a server with a claude thread to grant tools to.
func mcpTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	p, err := st.CreateProject(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	th, err := st.CreateThread(p.ID, "", protocol.ThreadClaude)
	if err != nil {
		t.Fatal(err)
	}
	bm := browser.NewManager(t.TempDir())
	t.Cleanup(bm.Shutdown)
	s := &Server{store: st, browsers: bm, mcp: mcp.NewServer("everywhere", "test", browser.Tools(bm)), mcpDir: t.TempDir()}
	t.Cleanup(s.mcp.Close)
	return s, th.ID
}

func TestBrowserKey(t *testing.T) {
	s, th := mcpTestServer(t)
	tab, err := s.store.CreateTab(th, protocol.ThreadClaude, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{th, tab.ID} {
		if key, err := s.browserKey(id); err != nil || key != th {
			t.Errorf("browserKey(%s) = %q %v, want the thread's", id, key, err)
		}
	}
	if _, err := s.browserKey("missing"); err == nil {
		t.Error("unknown thread has a browser")
	}
}

func TestClaudeArgs(t *testing.T) {
	s, th := mcpTestServer(t)
	args, release, err := s.claudeArgs(th, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(args) != 4 || args[0] != "--mcp-config" || args[2] != "--allowedTools" ||
		!strings.Contains(args[3], "mcp__everywhere__browser_snapshot,") {
		t.Fatalf("args = %q", args)
	}
	path := args[1]
	fi, err := os.Stat(path)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("config file: %v %v", fi, err)
	}
	var cfg struct {
		MCPServers map[string]struct {
			Type    string            `json:"type"`
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
		} `json:"mcpServers"`
	}
	b, _ := os.ReadFile(path)
	if err := json.Unmarshal(b, &cfg); err != nil {
		t.Fatal(err)
	}
	ew := cfg.MCPServers["everywhere"]
	if ew.Type != "http" || !strings.HasPrefix(ew.URL, "http://127.0.0.1:") {
		t.Fatalf("config = %s", b)
	}

	ping := func() int {
		req, _ := http.NewRequest(http.MethodPost, ew.URL, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
		req.Header.Set("Authorization", ew.Headers["Authorization"])
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if code := ping(); code != http.StatusOK {
		t.Fatalf("ping with the granted token: %d", code)
	}
	release()
	if code := ping(); code != http.StatusUnauthorized {
		t.Fatalf("ping after release: %d", code)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("config not removed: %v", err)
	}
}

// TestLiveMCP has a real claude use the browser tools through the flags a
// thread gets. It spends a little of the logged-in account's usage.
//
//	EW_CLAUDE_LIVE=1 go test ./internal/peer -run LiveMCP -v
func TestLiveMCP(t *testing.T) {
	if os.Getenv("EW_CLAUDE_LIVE") == "" {
		t.Skip("EW_CLAUDE_LIVE not set")
	}
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<!doctype html><title>Purple Walrus</title><h1>Hello</h1><button onclick="document.title='Clicked Walrus'">Press me</button>` +
			`<div style="width:400px;height:300px;background:#1a4fd6"></div>`))
	}))
	defer site.Close()

	s, th := mcpTestServer(t)
	args, release, err := s.claudeArgs(th, "")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	prompt := "Use the browser_navigate tool to open " + site.URL + ", then browser_snapshot. Then click the button with browser_click and call browser_status. " +
		"Reply with only the page title before the click and after it, separated by ' -> ', then on a new line the colour of the large " +
		"rectangle in the snapshot's screenshot as one word."
	cmd := exec.CommandContext(ctx, "claude", append([]string{"-p", prompt, "--model", "haiku", "--output-format", "json"}, args...)...)
	cmd.Dir = t.TempDir()
	var out, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("claude: %v\n%s\n%s", err, out.String(), stderr.String())
	}
	var res struct {
		Result            string `json:"result"`
		PermissionDenials []any  `json:"permission_denials"`
	}
	if err := json.Unmarshal(out.Bytes(), &res); err != nil {
		t.Fatalf("%v: %s", err, out.String())
	}
	t.Logf("claude said: %s", res.Result)
	if len(res.PermissionDenials) > 0 {
		t.Fatalf("permission denials: %v", res.PermissionDenials)
	}
	if !strings.Contains(res.Result, "Purple Walrus") || !strings.Contains(res.Result, "Clicked Walrus") ||
		!strings.Contains(strings.ToLower(res.Result), "blue") {
		t.Fatalf("result %q", res.Result)
	}
}
