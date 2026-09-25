package code

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestExec(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	r, err := Exec(ctx, dir, "echo out; echo err >&2; pwd; exit 3", "", 5*time.Second, nil)
	if err != nil || r.ExitCode != 3 || r.Stderr != "err\n" || !strings.HasPrefix(r.Stdout, "out\n") || !strings.Contains(r.Stdout, filepath.Base(dir)) {
		t.Fatalf("exec = %+v, %v", r, err)
	}
	r, _ = Exec(ctx, dir, "cat", "piped", 5*time.Second, nil)
	if r.Stdout != "piped" {
		t.Fatalf("stdin: %+v", r)
	}
	// A timeout kills the whole group, children included.
	start := time.Now()
	r, err = Exec(ctx, dir, "sleep 30 & sleep 30", "", 300*time.Millisecond, nil)
	if err != nil || !r.TimedOut || time.Since(start) > 5*time.Second {
		t.Fatalf("timeout: %+v, %v after %v", r, err, time.Since(start))
	}
	r, _ = Exec(ctx, dir, "head -c 200000 /dev/zero | tr '\\0' x", "", 5*time.Second, nil)
	if len(r.Stdout) != MaxStreamBytes || r.StdoutCut != 200000-MaxStreamBytes {
		t.Fatalf("cap: len %d cut %d", len(r.Stdout), r.StdoutCut)
	}
}

func TestReadWriteEdit(t *testing.T) {
	p := filepath.Join(t.TempDir(), "a", "b.txt")
	w, err := Write(p, "one\ntwo\nthree\ntwo\n")
	if err != nil || !w.Created {
		t.Fatalf("write: %+v %v", w, err)
	}
	r, err := Read(p, 2, 2)
	if err != nil || r.Content != "     2\ttwo\n     3\tthree\n" || r.TotalLines != 4 || !r.Truncated {
		t.Fatalf("read: %+v %v", r, err)
	}
	if _, err := Edit(p, "two", "2", false); err == nil || !strings.Contains(err.Error(), "2 times") {
		t.Fatalf("ambiguous edit: %v", err)
	}
	if e, err := Edit(p, "two", "2", true); err != nil || e.Replacements != 2 {
		t.Fatalf("replace all: %+v %v", e, err)
	}
	if _, err := Edit(p, "nope", "x", false); err == nil {
		t.Fatal("missing old_string should fail")
	}
	data, _ := os.ReadFile(p)
	if string(data) != "one\n2\nthree\n2\n" {
		t.Fatalf("content %q", data)
	}
	if err := os.WriteFile(p, []byte{'a', 0, 'b'}, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Read(p, 0, 0); err == nil {
		t.Fatal("binary file should fail")
	}
}

func TestGlobGrep(t *testing.T) {
	dir := t.TempDir()
	for _, f := range []string{"main.go", "pkg/util.go", "pkg/util_test.go", "web/app.ts", "node_modules/x/y.go"} {
		p := filepath.Join(dir, f)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		_ = os.WriteFile(p, []byte("package x\nfunc Hello() {}\n"), 0o644)
	}
	ctx := context.Background()
	g, err := Glob(ctx, dir, "**/*.go", 0)
	if err != nil || len(g.Files) != 3 {
		t.Fatalf("glob: %+v %v", g, err)
	}
	g, _ = Glob(ctx, dir, "pkg/*_test.go", 0)
	if len(g.Files) != 1 || g.Files[0] != "pkg/util_test.go" {
		t.Fatalf("glob dir: %+v", g)
	}
	g, _ = Glob(ctx, dir, "*.{ts,go}", 0)
	if len(g.Files) != 4 {
		t.Fatalf("glob braces: %+v", g)
	}
	r, err := Grep(ctx, dir, GrepOptions{Pattern: "func Hel+o", Glob: "*.go"}, nil)
	if err != nil || r.Count < 3 || !strings.Contains(r.Output, "pkg/util.go:2:func Hello() {}") {
		t.Fatalf("grep: %+v %v", r, err)
	}
	r, _ = Grep(ctx, dir, GrepOptions{Pattern: "nothing-here"}, nil)
	if r.Count != 0 {
		t.Fatalf("no match: %+v", r)
	}
	r, _ = Grep(ctx, filepath.Join(dir, "main.go"), GrepOptions{Pattern: "package", FilesOnly: true}, nil)
	if strings.TrimSpace(r.Output) != "main.go" {
		t.Fatalf("single file: %+v", r)
	}
}
