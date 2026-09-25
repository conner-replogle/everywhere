// Package favicon finds a project's icon: a well-known favicon or icon file,
// or the one an index.html or root route links to. Modeled on t3code's
// ProjectFaviconResolver.
package favicon

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// MaxBytes is the largest icon sent to the web app; bigger files are skipped.
const MaxBytes = 256 << 10

// candidates are checked in order, relative to the project root.
var candidates = []string{
	"favicon.svg", "favicon.ico", "favicon.png",
	"public/favicon.svg", "public/favicon.ico", "public/favicon.png",
	"app/favicon.ico", "app/favicon.png", "app/icon.svg", "app/icon.png", "app/icon.ico",
	"src/favicon.ico", "src/favicon.svg", "src/app/favicon.ico", "src/app/icon.svg", "src/app/icon.png",
	"assets/icon.svg", "assets/icon.png", "assets/logo.svg", "assets/logo.png",
	".idea/icon.svg",
}

// sources may link an icon: <link rel="icon" href=…>, or a route's
// head() links entry { rel: "icon", href: … }.
var sources = []string{
	"index.html", "public/index.html", "src/index.html",
	"app/routes/__root.tsx", "src/routes/__root.tsx", "app/root.tsx", "src/root.tsx",
}

var (
	linkRe    = regexp.MustCompile(`(?i)<link\b[^>]*>`)
	relIconRe = regexp.MustCompile(`(?i)\brel=["'](?:icon|shortcut icon)["']`)
	hrefRe    = regexp.MustCompile(`(?i)\bhref=["']([^"'?#]+)`)
	objRelRe  = regexp.MustCompile(`(?i)\brel\s*:\s*["'](?:icon|shortcut icon)["']`)
	objHrefRe = regexp.MustCompile(`(?i)\bhref\s*:\s*["']([^"'?#]+)`)
)

var mimes = map[string]string{
	".svg":  "image/svg+xml",
	".ico":  "image/x-icon",
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
}

// Icon is an icon file, ready for a data: URL.
type Icon struct {
	Mime string `json:"mime"`
	// Data is the file, base64.
	Data string `json:"data"`
	// Rev changes when the file does.
	Rev string `json:"rev"`
}

// Find returns root's icon, or nil if it has none.
func Find(root string) (*Icon, error) {
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	path := find(root)
	if path == "" {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	return &Icon{
		Mime: mimes[strings.ToLower(filepath.Ext(path))],
		Data: base64.StdEncoding.EncodeToString(data),
		Rev:  hex.EncodeToString(sum[:8]),
	}, nil
}

func find(root string) string {
	for _, c := range candidates {
		if p := usable(root, c); p != "" {
			return p
		}
	}
	for _, s := range sources {
		src, err := os.ReadFile(filepath.Join(root, s))
		if err != nil || len(src) > 1<<20 {
			continue
		}
		href := linkedIcon(string(src))
		if href == "" {
			continue
		}
		href = strings.TrimPrefix(href, "/")
		// Vite and friends serve public/ at the site root.
		for _, rel := range []string{filepath.Join("public", href), href, filepath.Join(filepath.Dir(s), href)} {
			if p := usable(root, rel); p != "" {
				return p
			}
		}
	}
	return ""
}

// linkedIcon is the href of the first icon link in an HTML or TSX source.
func linkedIcon(src string) string {
	for _, tag := range linkRe.FindAllString(src, -1) {
		if relIconRe.MatchString(tag) {
			if m := hrefRe.FindStringSubmatch(tag); m != nil {
				return m[1]
			}
		}
	}
	for _, part := range strings.Split(src, "}") {
		if objRelRe.MatchString(part) {
			if m := objHrefRe.FindStringSubmatch(part); m != nil {
				return m[1]
			}
		}
	}
	return ""
}

// usable resolves rel under root: a regular image file no bigger than
// MaxBytes that doesn't lead out of root through a symlink.
func usable(root, rel string) string {
	if strings.HasPrefix(rel, "http:") || strings.HasPrefix(rel, "https:") || strings.HasPrefix(rel, "data:") {
		return ""
	}
	if _, ok := mimes[strings.ToLower(filepath.Ext(rel))]; !ok {
		return ""
	}
	p, err := filepath.EvalSymlinks(filepath.Join(root, filepath.Clean("/"+rel)))
	if err != nil || !within(root, p) {
		return ""
	}
	fi, err := os.Stat(p)
	if err != nil || !fi.Mode().IsRegular() || fi.Size() == 0 || fi.Size() > MaxBytes {
		return ""
	}
	return p
}

func within(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
