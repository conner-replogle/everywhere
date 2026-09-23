package claude

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The test binary doubles as a fake claude CLI: with EW_FAKE_CLAUDE set it
// speaks the CLI's side of the protocol instead of running tests. The user
// prompt's text picks the scenario.
func TestMain(m *testing.M) {
	if os.Getenv("EW_FAKE_CLAUDE") != "" {
		fakeClaude()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func fakeClaude() {
	if os.Getenv("EW_FAKE_CLAUDE") == "crash" {
		fmt.Fprintln(os.Stderr, "error: unknown option '--bogus'")
		os.Exit(1)
	}
	out := json.NewEncoder(os.Stdout)
	emit := func(v any) { _ = out.Encode(v) }
	result := func(text string) {
		emit(map[string]any{"type": "result", "subtype": "success", "result": text, "session_id": "sess-1"})
	}
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(nil, 1<<20)
	// next reads frames until one satisfies want, answering interrupts.
	next := func(want func(map[string]any) bool) map[string]any {
		for in.Scan() {
			var f map[string]any
			_ = json.Unmarshal(in.Bytes(), &f)
			if want(f) {
				return f
			}
		}
		os.Exit(0)
		return nil
	}
	isResponse := func(f map[string]any) bool { return f["type"] == "control_response" }

	for {
		f := next(func(map[string]any) bool { return true })
		switch f["type"] {
		case "control_request":
			req := f["request"].(map[string]any)
			resp := map[string]any{}
			if req["subtype"] == "initialize" {
				resp = map[string]any{"pid": os.Getpid(), "account": map[string]any{"email": "fake@example.com"}}
			}
			emit(map[string]any{"type": "control_response", "response": map[string]any{
				"subtype": "success", "request_id": f["request_id"], "response": resp,
			}})
			if req["subtype"] == "interrupt" {
				emit(map[string]any{"type": "result", "subtype": "error_during_execution", "is_error": true})
			}
		case "user":
			content := f["message"].(map[string]any)["content"].([]any)
			prompt := content[0].(map[string]any)["text"].(string)
			emit(map[string]any{"type": "system", "subtype": "init", "session_id": "sess-1"})
			switch prompt {
			case "write":
				emit(map[string]any{"type": "control_request", "request_id": "perm-1", "request": map[string]any{
					"subtype": "can_use_tool", "tool_name": "Write", "tool_use_id": "toolu_1",
					"input": map[string]any{"file_path": "a.txt"},
				}})
				r := next(isResponse)["response"].(map[string]any)
				b, _ := json.Marshal(r)
				result(string(b))
			case "flood":
				// Far more than any channel buffer; the consumer isn't reading.
				for i := range 5000 {
					emit(map[string]any{"type": "stream_event", "event": map[string]any{"type": "content_block_delta", "i": i}})
				}
			case "hook":
				emit(map[string]any{"type": "control_request", "request_id": "hook-1", "request": map[string]any{"subtype": "hook_callback"}})
				r := next(isResponse)["response"].(map[string]any)
				result(fmt.Sprint(r["subtype"], ": ", r["error"]))
			case "cancel":
				emit(map[string]any{"type": "control_request", "request_id": "perm-2", "request": map[string]any{
					"subtype": "can_use_tool", "tool_name": "Bash", "tool_use_id": "toolu_2", "input": map[string]any{},
				}})
				emit(map[string]any{"type": "control_cancel_request", "request_id": "perm-2"})
				result("canceled")
			case "stubborn":
				signal.Ignore(syscall.SIGTERM)
				result("ignoring SIGTERM")
				for {
					time.Sleep(time.Hour)
				}
			default:
				result("echo: " + prompt)
			}
		}
	}
}

func startFake(t *testing.T, mode string) *Session {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s, err := Start(ctx, Options{Binary: exe, Env: append(os.Environ(), "EW_FAKE_CLAUDE="+mode)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		go func() {
			for range s.Messages() {
			}
		}()
		s.Close()
	})
	return s
}

func send(t *testing.T, s *Session, text string) {
	t.Helper()
	if err := s.Send(UserMessage{Content: []ContentBlock{Text(text)}}); err != nil {
		t.Fatal(err)
	}
}

// waitFor reads messages until one of the given type arrives.
func waitFor(t *testing.T, s *Session, typ string) Message {
	t.Helper()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case m, ok := <-s.Messages():
			if !ok {
				t.Fatalf("session ended waiting for %q: %v", typ, s.Err())
			}
			if m.Type == typ {
				return m
			}
		case <-timeout:
			t.Fatalf("timed out waiting for %q", typ)
		}
	}
}

func resultText(t *testing.T, m Message) string {
	t.Helper()
	var r Result
	if err := m.Decode(&r); err != nil {
		t.Fatal(err)
	}
	return r.Result
}

func TestInitialize(t *testing.T) {
	s := startFake(t, "1")
	if got := s.Init().Account.Email; got != "fake@example.com" {
		t.Fatalf("account email = %q", got)
	}
	send(t, s, "hello")
	if got := resultText(t, waitFor(t, s, "result")); got != "echo: hello" {
		t.Fatalf("result = %q", got)
	}
}

func TestStartReportsStderrWhenCLIExits(t *testing.T) {
	exe, _ := os.Executable()
	_, err := Start(context.Background(), Options{Binary: exe, Env: append(os.Environ(), "EW_FAKE_CLAUDE=crash")})
	if err == nil || !strings.Contains(err.Error(), "unknown option '--bogus'") {
		t.Fatalf("err = %v, want the CLI's stderr", err)
	}
}

func TestPermissionAllow(t *testing.T) {
	s := startFake(t, "1")
	send(t, s, "write")
	m := waitFor(t, s, "control_request")
	if m.Permission == nil || m.Permission.ToolName != "Write" || m.Permission.ID != "perm-1" {
		t.Fatalf("permission = %+v", m.Permission)
	}
	if err := s.Respond(m.Permission, Allow()); err != nil {
		t.Fatal(err)
	}
	var got struct {
		RequestID string           `json:"request_id"`
		Response  PermissionResult `json:"response"`
	}
	if err := json.Unmarshal([]byte(resultText(t, waitFor(t, s, "result"))), &got); err != nil {
		t.Fatal(err)
	}
	r := got.Response
	if got.RequestID != "perm-1" || r.Behavior != "allow" || r.ToolUseID != "toolu_1" || string(r.UpdatedInput) != `{"file_path":"a.txt"}` {
		t.Fatalf("CLI received %+v, want allow with the original input echoed", got)
	}
}

func TestPermissionDenyHasMessage(t *testing.T) {
	s := startFake(t, "1")
	send(t, s, "write")
	m := waitFor(t, s, "control_request")
	if err := s.Respond(m.Permission, Deny("")); err != nil {
		t.Fatal(err)
	}
	text := resultText(t, waitFor(t, s, "result"))
	if !strings.Contains(text, `"behavior":"deny"`) || !strings.Contains(text, `"message":"The user denied`) {
		t.Fatalf("CLI received %s", text)
	}
}

// Control calls must not depend on the consumer draining Messages, or an
// actor that calls Interrupt from its message loop would deadlock.
func TestInterruptWhileConsumerIsNotReading(t *testing.T) {
	s := startFake(t, "1")
	send(t, s, "flood")
	time.Sleep(200 * time.Millisecond) // let the flood fill every buffer
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Interrupt(ctx); err != nil {
		t.Fatalf("interrupt: %v", err)
	}
	n := 0
	for m := range s.Messages() {
		if m.Type == "stream_event" {
			n++
		}
		if m.Type == "result" {
			break
		}
	}
	if n != 5000 {
		t.Fatalf("got %d stream events before the result, want all 5000 in order", n)
	}
}

func TestUnsupportedControlRequestIsRefused(t *testing.T) {
	s := startFake(t, "1")
	send(t, s, "hook")
	if got := resultText(t, waitFor(t, s, "result")); !strings.HasPrefix(got, `error: unsupported control request "hook_callback"`) {
		t.Fatalf("CLI received %q", got)
	}
}

func TestCancelRequest(t *testing.T) {
	s := startFake(t, "1")
	send(t, s, "cancel")
	if m := waitFor(t, s, "control_request"); m.Permission.ID != "perm-2" {
		t.Fatalf("permission = %+v", m.Permission)
	}
	if m := waitFor(t, s, "control_cancel_request"); m.CanceledRequestID != "perm-2" {
		t.Fatalf("canceled = %q", m.CanceledRequestID)
	}
}

func TestCloseKillsStubbornProcess(t *testing.T) {
	old := closeTimeout
	closeTimeout = 100 * time.Millisecond
	defer func() { closeTimeout = old }()

	s := startFake(t, "1")
	send(t, s, "stubborn")
	waitFor(t, s, "result")
	go func() {
		for range s.Messages() {
		}
	}()
	done := make(chan struct{})
	go func() { s.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Close didn't kill a process that ignores stdin EOF and SIGTERM")
	}
	if err := s.Interrupt(context.Background()); err != ErrExited {
		t.Fatalf("interrupt after close: %v, want ErrExited", err)
	}
}
