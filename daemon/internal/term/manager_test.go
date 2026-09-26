package term

import (
	"bytes"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeResolver struct {
	dir     string
	spawned int
}

func (r *fakeResolver) ThreadShell(string) (string, bool, error) { return r.dir, r.spawned > 0, nil }
func (r *fakeResolver) MarkSpawned(string) error                 { r.spawned++; return nil }
func (r *fakeResolver) TouchThread(string) error                 { return nil }

type fakeClient struct {
	mu     sync.Mutex
	out    bytes.Buffer
	writer []bool
	exited chan int
}

func newClient() *fakeClient { return &fakeClient{exited: make(chan int, 1)} }

func (c *fakeClient) Output(p []byte) { c.mu.Lock(); c.out.Write(p); c.mu.Unlock() }
func (c *fakeClient) Writer(you bool) { c.mu.Lock(); c.writer = append(c.writer, you); c.mu.Unlock() }
func (c *fakeClient) Exited(code int) { c.exited <- code }

func (c *fakeClient) isWriter() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.writer) > 0 && c.writer[len(c.writer)-1]
}

func (c *fakeClient) waitFor(t *testing.T, s string) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		c.mu.Lock()
		ok := strings.Contains(c.out.String(), s)
		c.mu.Unlock()
		if ok {
			return
		}
	}
	t.Fatalf("output never contained %q", s)
}

func TestWriterLifecycle(t *testing.T) {
	t.Setenv("SHELL", "/bin/sh")
	m := NewManager(&fakeResolver{dir: t.TempDir()}, nil)
	defer m.Shutdown()

	a, b := newClient(), newClient()
	if err := m.Attach("t1", a, 80, 24); err != nil {
		t.Fatal(err)
	}
	if err := m.Attach("t1", b, 80, 24); err != nil {
		t.Fatal(err)
	}
	if !a.isWriter() || b.isWriter() {
		t.Fatal("first attacher should be the only writer")
	}

	m.Input("t1", b, []byte("echo from-b\n")) // dropped
	m.Input("t1", a, []byte("echo from-a\n"))
	b.waitFor(t, "from-a\r\n")
	b.mu.Lock()
	leaked := strings.Contains(b.out.String(), "from-b\r\n")
	b.mu.Unlock()
	if leaked {
		t.Error("non-writer input reached the shell")
	}

	m.Takeover("t1", b, 100, 30)
	if a.isWriter() || !b.isWriter() {
		t.Fatal("takeover didn't move the writer")
	}
	m.Detach("t1", b)
	if !a.isWriter() {
		t.Fatal("remaining client should be promoted when the writer leaves")
	}

	m.Input("t1", a, []byte("exit\n"))
	select {
	case <-a.exited:
	case <-time.After(5 * time.Second):
		t.Fatal("no exit")
	}
	if m.Running("t1") {
		t.Error("thread still running after exit")
	}

	// Reattach respawns with the restart notice replayed first.
	c := newClient()
	if err := m.Attach("t1", c, 80, 24); err != nil {
		t.Fatal(err)
	}
	c.waitFor(t, "previous session ended")
}
