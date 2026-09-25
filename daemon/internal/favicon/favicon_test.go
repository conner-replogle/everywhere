package favicon

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, root, rel, body string) {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestFind(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		want  string // path relative to root, "" for none
	}{
		{"none", map[string]string{"README.md": "hi"}, ""},
		{"well-known order", map[string]string{"public/favicon.png": "p", "favicon.ico": "i"}, "favicon.ico"},
		{"html link into public", map[string]string{
			"index.html":      `<head><link rel="stylesheet" href="/a.css"><link href="/logo.svg?v=2" rel="icon"></head>`,
			"public/logo.svg": "<svg/>",
		}, "public/logo.svg"},
		{"tanstack head links", map[string]string{
			"src/routes/__root.tsx": `head: () => ({ links: [{ rel: "stylesheet", href: css }, { rel: "icon", href: "/brand.png" }] })`,
			"public/brand.png":      "png",
		}, "public/brand.png"},
		{"remote href skipped", map[string]string{"index.html": `<link rel="icon" href="https://x.test/f.ico">`}, ""},
		{"not an image", map[string]string{"index.html": `<link rel="icon" href="/f.txt">`, "public/f.txt": "x"}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			root := t.TempDir()
			for rel, body := range c.files {
				write(t, root, rel, body)
			}
			real, _ := filepath.EvalSymlinks(root)
			got := find(real)
			want := ""
			if c.want != "" {
				want = filepath.Join(real, c.want)
			}
			if got != want {
				t.Fatalf("find = %q, want %q", got, want)
			}
		})
	}
}

func TestSymlinkOutOfRoot(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	write(t, outside, "secret.png", "s")
	if err := os.Symlink(filepath.Join(outside, "secret.png"), filepath.Join(root, "favicon.png")); err != nil {
		t.Fatal(err)
	}
	if icon, err := Find(root); err != nil || icon != nil {
		t.Fatalf("Find = %v, %v; want no icon", icon, err)
	}
}

func TestFindEncodes(t *testing.T) {
	root := t.TempDir()
	write(t, root, "favicon.svg", "<svg/>")
	icon, err := Find(root)
	if err != nil || icon == nil {
		t.Fatalf("Find = %v, %v", icon, err)
	}
	if icon.Mime != "image/svg+xml" || icon.Data != "PHN2Zy8+" || len(icon.Rev) != 16 {
		t.Fatalf("icon = %+v", icon)
	}
}
