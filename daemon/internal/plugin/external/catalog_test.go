package external

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testManifest = `{"id":"hello","title":"Hello","version":"1.0.0","api":1,"command":["./hello"]}`

// registry serves an index with one plugin, and its archive (made from files).
func registry(t *testing.T, files map[string]string, mutate func(*CatalogEntry)) (string, CatalogEntry) {
	t.Helper()
	src := t.TempDir()
	for name, body := range files {
		p := filepath.Join(src, name)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	var buf bytes.Buffer
	if err := Pack(src, &buf); err != nil {
		t.Fatal(err)
	}
	archive := buf.Bytes()
	sum := sha256.Sum256(archive)
	var m Manifest
	if err := json.Unmarshal([]byte(testManifest), &m); err != nil {
		t.Fatal(err)
	}
	e := CatalogEntry{Manifest: m, Artifacts: map[string]Artifact{
		Platform(): {URL: "hello.tar.gz", SHA256: hex.EncodeToString(sum[:]), Size: int64(len(archive))},
	}}
	if mutate != nil {
		mutate(&e)
	}
	idx, _ := json.Marshal(Catalog{API: CatalogAPI, Plugins: []CatalogEntry{e}})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/index.json":
			_, _ = w.Write(idx)
		case "/hello.tar.gz":
			_, _ = w.Write(archive)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL + "/index.json", e
}

func TestInstallFromRegistry(t *testing.T) {
	url, _ := registry(t, map[string]string{"plugin.json": testManifest, "hello": "#!/bin/sh\n", "main.go": "package main"}, nil)
	cat, err := FetchCatalog(context.Background(), url, true)
	if err != nil {
		t.Fatal(err)
	}
	e, ok := cat.Find("hello")
	if !ok {
		t.Fatal("hello isn't in the index")
	}
	root := filepath.Join(t.TempDir(), "plugins")
	if err := InstallFrom(context.Background(), url, e, root); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "hello")
	if _, err := ReadManifest(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "main.go")); err == nil {
		t.Error("sources were packed")
	}
	if info, err := os.Stat(filepath.Join(dir, "hello")); err != nil || info.Mode()&0o100 == 0 {
		t.Errorf("program isn't executable: %v", err)
	}
	if src, ok := InstalledFrom(dir); !ok || src.Version != "1.0.0" || src.Registry != url {
		t.Errorf("source = %+v, %v", src, ok)
	}
	if installed, bad := Installed(root); len(installed) != 1 || len(bad) != 0 {
		t.Errorf("installed %v, bad %v", installed, bad)
	}
	// Installing again replaces it, leaving nothing beside it.
	if err := InstallFrom(context.Background(), url, e, root); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Dir(root))
	for _, d := range entries {
		if strings.HasPrefix(d.Name(), ".") {
			t.Errorf("left %s behind", d.Name())
		}
	}
}

func TestInstallRefusesWrongChecksum(t *testing.T) {
	url, e := registry(t, map[string]string{"plugin.json": testManifest, "hello": "x"}, func(e *CatalogEntry) {
		a := e.Artifacts[Platform()]
		a.SHA256 = strings.Repeat("0", 64)
		e.Artifacts[Platform()] = a
	})
	err := InstallFrom(context.Background(), url, e, t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("err = %v", err)
	}
}

func TestInstallRefusesOtherManifest(t *testing.T) {
	// The archive asks for more than the index showed.
	more := strings.Replace(testManifest, `"api":1`, `"api":1,"permissions":["exec"]`, 1)
	url, e := registry(t, map[string]string{"plugin.json": more, "hello": "x"}, nil)
	var shown Manifest
	_ = json.Unmarshal([]byte(testManifest), &shown)
	e.Manifest = shown
	err := InstallFrom(context.Background(), url, e, t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "different plugin.json") {
		t.Fatalf("err = %v", err)
	}
}

func TestUnpackStaysInside(t *testing.T) {
	for _, name := range []string{"../evil", "/etc/evil", "a/../../evil"} {
		var buf bytes.Buffer
		gz := gzip.NewWriter(&buf)
		tw := tar.NewWriter(gz)
		_ = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: 1, Typeflag: tar.TypeReg})
		_, _ = tw.Write([]byte("x"))
		_ = tw.Close()
		_ = gz.Close()
		if err := Unpack(&buf, t.TempDir()); err == nil {
			t.Errorf("%s: unpacked", name)
		}
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "link", Linkname: "/etc/passwd", Typeflag: tar.TypeSymlink})
	_ = tw.Close()
	_ = gz.Close()
	if err := Unpack(&buf, t.TempDir()); err == nil {
		t.Error("unpacked a symlink")
	}
}
