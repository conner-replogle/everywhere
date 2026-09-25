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

	// macOS archives have no worker; the daemon is still replaced.
	dir = t.TempDir()
	exe = filepath.Join(dir, "everywhere")
	if err := install(exe, tarball(t, map[string]string{"everywhere": "mac"})); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "everywhere-desktop")); !os.IsNotExist(err) {
		t.Errorf("worker installed from an archive without one: %v", err)
	}
}
