package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"
)

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"0.1.2", "0.1.1", true},
		{"v0.2.0", "0.1.9", true},
		{"0.1.10", "0.1.9", true},
		{"0.1.1", "0.1.1", false},
		{"0.1.0", "0.1.1", false},
		{"1.0", "0.9.9", true},
		{"0.1.2", "dev", false},
		{"dev", "0.1.1", false},
		{"0.2.0-rc1", "0.1.0", true},
	} {
		if got := Newer(c.a, c.b); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func tarball(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range files {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func TestInstallWithWorker(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "everywhere")
	os.WriteFile(exe, []byte("old"), 0o755)
	if err := install(exe, tarball(t, map[string]string{"everywhere": "new", "everywhere-desktop": "worker", "README.md": "x"})); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"everywhere": "new", "everywhere-desktop": "worker"} {
		got, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || string(got) != want {
			t.Errorf("%s = %q, %v", name, got, err)
		}
	}

	// An archive without a worker still replaces the daemon.
	dir = t.TempDir()
	exe = filepath.Join(dir, "everywhere")
	if err := install(exe, tarball(t, map[string]string{"everywhere": "plain"})); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "everywhere-desktop")); !os.IsNotExist(err) {
		t.Errorf("worker installed from an archive without one: %v", err)
	}
}

func TestReplaceMovesOldAside(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "everywhere")
	os.WriteFile(exe, []byte("old"), 0o755)
	if err := replace(exe, []byte("new")); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(exe); string(got) != "new" {
		t.Fatalf("binary = %q, want new", got)
	}
	Cleanup(exe)
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("left behind %v", entries)
	}
}

func TestReplaceTree(t *testing.T) {
	archive := tarball(t, map[string]string{
		"everywhere": "new",
		"EverywhereDesktop.app/Contents/Info.plist":               "plist",
		"EverywhereDesktop.app/Contents/MacOS/everywhere-desktop": "app",
	})
	files, err := extractTree(archive, "EverywhereDesktop.app")
	if err != nil || len(files) != 2 {
		t.Fatalf("extractTree = %v, %v", files, err)
	}
	dir := t.TempDir()
	app := filepath.Join(dir, "EverywhereDesktop.app")
	os.MkdirAll(filepath.Join(app, "Contents", "Stale"), 0o755)
	if err := replaceTree(app, files); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(app, "Contents", "MacOS", "everywhere-desktop")); string(got) != "app" {
		t.Errorf("app binary = %q", got)
	}
	if _, err := os.Stat(filepath.Join(app, "Contents", "Stale")); !os.IsNotExist(err) {
		t.Errorf("the old app's files survived: %v", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Errorf("left behind %v", entries)
	}
}

func TestEnsureWorkerLeavesPresentOrDev(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "everywhere")
	// A development build doesn't download a release's worker.
	if installed, err := EnsureWorker(exe, "dev"); installed || err != nil {
		t.Errorf("dev build: installed %v, %v", installed, err)
	}
	// Nor does a release whose worker is already there.
	os.MkdirAll(filepath.Join(dir, WorkerName), 0o755)
	if installed, err := EnsureWorker(exe, "0.28.1"); installed || err != nil {
		t.Errorf("worker present: installed %v, %v", installed, err)
	}
}
