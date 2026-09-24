package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	s := NewServer("test", "1.0", []Tool{
		{
			Name: "echo", Title: "Echo", Description: "Echoes who called and with what.",
			InputSchema: json.RawMessage(`{"type":"object","properties":{"say":{"type":"string"}}}`),
			Annotations: Annotations{ReadOnly: true, Idempotent: true},
			Call: func(_ context.Context, c Caller, args json.RawMessage) (*Result, error) {
				var a struct{ Say string }
				if err := json.Unmarshal(args, &a); err != nil {
					return nil, err
				}
				return Text(c.ThreadID+"/"+c.ProjectID+":"+a.Say).Image([]byte{1, 2, 3}, "image/png"), nil
			},
		},
		{
			Name: "fail", InputSchema: json.RawMessage(`{"type":"object"}`),
			Call: func(context.Context, Caller, json.RawMessage) (*Result, error) {
				return nil, errors.New("it broke")
			},
		},
		{
			Name: "panic", InputSchema: json.RawMessage(`{"type":"object"}`),
			Call: func(context.Context, Caller, json.RawMessage) (*Result, error) { panic("boom") },
		},
	})
	hs := httptest.NewServer(s)
	t.Cleanup(hs.Close)
	return s, hs
}

func post(t *testing.T, url, token, origin, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url+Path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

func rpc(t *testing.T, url, token, body string) map[string]any {
	t.Helper()
	code, out := post(t, url, token, "", body)
	if code != http.StatusOK {
		t.Fatalf("status %d: %s", code, out)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	return m
}

func TestHandshakeAndTools(t *testing.T) {
	s, hs := testServer(t)
	token := s.AddToken(Caller{ThreadID: "t1", ProjectID: "p1"})

	init := rpc(t, hs.URL, token, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}`)
	res := init["result"].(map[string]any)
	if res["protocolVersion"] != "2025-03-26" || res["capabilities"].(map[string]any)["tools"] == nil {
		t.Fatalf("initialize = %v", init)
	}
	init = rpc(t, hs.URL, token, `{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2099-01-01"}}`)
	if v := init["result"].(map[string]any)["protocolVersion"]; v != "2025-06-18" {
		t.Fatalf("unknown version negotiated to %v", v)
	}

	if code, body := post(t, hs.URL, token, "", `{"jsonrpc":"2.0","method":"notifications/initialized"}`); code != http.StatusAccepted || body != "" {
		t.Fatalf("notification: %d %q", code, body)
	}
	if r := rpc(t, hs.URL, token, `{"jsonrpc":"2.0","id":"p","method":"ping"}`); r["id"] != "p" || r["result"] == nil {
		t.Fatalf("ping = %v", r)
	}

	list := rpc(t, hs.URL, token, `{"jsonrpc":"2.0","id":3,"method":"tools/list"}`)
	tools := list["result"].(map[string]any)["tools"].([]any)
	echo := tools[0].(map[string]any)
	ann := echo["annotations"].(map[string]any)
	if len(tools) != 3 || echo["name"] != "echo" || echo["title"] != "Echo" || echo["inputSchema"].(map[string]any)["type"] != "object" ||
		ann["readOnlyHint"] != true || ann["destructiveHint"] != false || ann["openWorldHint"] != false {
		t.Fatalf("tools/list = %v", list)
	}

	call := rpc(t, hs.URL, token, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"echo","arguments":{"say":"hi"}}}`)
	content := call["result"].(map[string]any)["content"].([]any)
	if content[0].(map[string]any)["text"] != "t1/p1:hi" {
		t.Fatalf("call = %v", call)
	}
	if img := content[1].(map[string]any); img["type"] != "image" || img["data"] != "AQID" || img["mimeType"] != "image/png" {
		t.Fatalf("image = %v", img)
	}

	for _, name := range []string{"fail", "panic"} {
		call = rpc(t, hs.URL, token, `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"`+name+`"}}`)
		r := call["result"].(map[string]any)
		if r["isError"] != true {
			t.Fatalf("%s = %v", name, call)
		}
	}

	call = rpc(t, hs.URL, token, `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"nope"}}`)
	if e := call["error"].(map[string]any); e["code"].(float64) != codeInvalidParams {
		t.Fatalf("unknown tool = %v", call)
	}
	call = rpc(t, hs.URL, token, `{"jsonrpc":"2.0","id":7,"method":"resources/list"}`)
	if e := call["error"].(map[string]any); e["code"].(float64) != codeNoMethod {
		t.Fatalf("unknown method = %v", call)
	}

	// A batch answers its requests and skips its notifications.
	code, out := post(t, hs.URL, token, "", `[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"}]`)
	var batch []map[string]any
	if code != http.StatusOK || json.Unmarshal([]byte(out), &batch) != nil || len(batch) != 1 {
		t.Fatalf("batch: %d %s", code, out)
	}
}

func TestAuthAndOrigin(t *testing.T) {
	s, hs := testServer(t)
	token := s.AddToken(Caller{ThreadID: "t1"})
	ping := `{"jsonrpc":"2.0","id":1,"method":"ping"}`

	if code, _ := post(t, hs.URL, "", "", ping); code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", code)
	}
	if code, _ := post(t, hs.URL, "wrong", "", ping); code != http.StatusUnauthorized {
		t.Fatalf("bad token: %d", code)
	}
	if code, _ := post(t, hs.URL, token, "https://evil.example", ping); code != http.StatusForbidden {
		t.Fatalf("foreign origin: %d", code)
	}
	for _, o := range []string{"http://localhost:3000", "http://127.0.0.1:8080", "http://[::1]"} {
		if code, _ := post(t, hs.URL, token, o, ping); code != http.StatusOK {
			t.Fatalf("origin %s: %d", o, code)
		}
	}

	resp, err := http.Get(hs.URL + Path)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET: %d", resp.StatusCode)
	}

	s.Revoke(token)
	if code, _ := post(t, hs.URL, token, "", ping); code != http.StatusUnauthorized {
		t.Fatalf("revoked token: %d", code)
	}
}

func TestGrantListens(t *testing.T) {
	s := NewServer("test", "1", nil)
	defer s.Close()
	endpoint, token, release, err := s.Grant(Caller{ThreadID: "t"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(endpoint, "http://127.0.0.1:") || !strings.HasSuffix(endpoint, Path) {
		t.Fatalf("endpoint %s", endpoint)
	}
	base := strings.TrimSuffix(endpoint, Path)
	if r := rpc(t, base, token, `{"jsonrpc":"2.0","id":1,"method":"ping"}`); r["result"] == nil {
		t.Fatalf("ping = %v", r)
	}
	release()
	release()
	if code, _ := post(t, base, token, "", `{"jsonrpc":"2.0","id":1,"method":"ping"}`); code != http.StatusUnauthorized {
		t.Fatalf("released token: %d", code)
	}
}
