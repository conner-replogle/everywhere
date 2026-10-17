// Package dashboard builds the dashboards agents write for processes:
// .everywhere/dashboards/<name>/index.tsx in a thread's directory, bundled
// with esbuild into one script the web app runs in a sandboxed frame. React
// and the "everywhere" components come from that frame, not the bundle.
package dashboard

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/evanw/esbuild/pkg/api"
)

// Types is the API dashboards use, written to .everywhere/types for the
// agent (and editors) to read.
//
//go:embed everywhere.d.ts
var Types string

// Root is where a project keeps what everywhere makes for it.
const Root = ".everywhere"

const (
	maxBundle = 8 << 20
	maxFiles  = 2000 // looked at for changes
)

var nameRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// Dir is a dashboard's directory in a thread's directory.
func Dir(workdir, name string) (string, error) {
	if !nameRe.MatchString(name) {
		return "", fmt.Errorf("dashboard %q: name it with letters, digits, - and _", name)
	}
	return filepath.Join(workdir, Root, "dashboards", name), nil
}

// Result is a build: the script and styles, or what's wrong.
type Result struct {
	// Version changes when the dashboard's files do.
	Version  string   `json:"version"`
	JS       string   `json:"js,omitempty"`
	CSS      string   `json:"css,omitempty"`
	Errors   []string `json:"errors,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

// Builder builds dashboards, keeping the last build of each until its
// files change.
type Builder struct {
	mu    sync.Mutex
	cache map[string]Result // by directory
}

func NewBuilder() *Builder { return &Builder{cache: map[string]Result{}} }

// Build builds the dashboard in dir, or returns the last build if nothing
// changed. It also refreshes .everywhere/types next to it.
func (b *Builder) Build(dir string) Result {
	version, err := version(dir)
	if err != nil {
		return Result{Version: "missing", Errors: []string{err.Error()}}
	}
	b.mu.Lock()
	if r, ok := b.cache[dir]; ok && r.Version == version {
		b.mu.Unlock()
		return r
	}
	b.mu.Unlock()
	writeTypes(filepath.Dir(filepath.Dir(dir)))
	r := build(dir)
	r.Version = version
	b.mu.Lock()
	b.cache[dir] = r
	b.mu.Unlock()
	return r
}

// version sums up the dashboard's files' names, sizes and times.
func version(dir string) (string, error) {
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("no dashboard at %s: write its index.tsx there", dir)
	}
	h := sha256.New()
	n := 0
	err = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && path != dir && (d.Name() == "node_modules" || strings.HasPrefix(d.Name(), ".")) {
			return filepath.SkipDir
		}
		if n++; n > maxFiles {
			return filepath.SkipAll
		}
		if i, err := d.Info(); err == nil && !d.IsDir() {
			fmt.Fprintf(h, "%s\x00%d\x00%d\n", path, i.Size(), i.ModTime().UnixNano())
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil))[:16], nil
}

var entries = []string{"index.tsx", "index.ts", "index.jsx", "index.js"}

// Provided are the modules the frame gives a dashboard.
var Provided = []string{"everywhere", "react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client"}

func build(dir string) Result {
	entry := ""
	for _, e := range entries {
		if _, err := os.Stat(filepath.Join(dir, e)); err == nil {
			entry = e
			break
		}
	}
	if entry == "" {
		return Result{Errors: []string{fmt.Sprintf("no index.tsx in %s", dir)}}
	}
	provided := api.Plugin{
		Name: "everywhere",
		Setup: func(pb api.PluginBuild) {
			filter := "^(" + strings.Join(quoteAll(Provided), "|") + ")$"
			pb.OnResolve(api.OnResolveOptions{Filter: filter}, func(a api.OnResolveArgs) (api.OnResolveResult, error) {
				return api.OnResolveResult{Path: a.Path, Namespace: "everywhere"}, nil
			})
			pb.OnLoad(api.OnLoadOptions{Filter: ".*", Namespace: "everywhere"}, func(a api.OnLoadArgs) (api.OnLoadResult, error) {
				js := fmt.Sprintf("module.exports = globalThis.__everywhere.modules[%q];", a.Path)
				return api.OnLoadResult{Contents: &js, Loader: api.LoaderJS}, nil
			})
		},
	}
	res := api.Build(api.BuildOptions{
		EntryPoints:   []string{entry},
		AbsWorkingDir: dir,
		Bundle:        true,
		Write:         false,
		Outdir:        "out",
		Format:        api.FormatIIFE,
		GlobalName:    "__dashboard",
		Platform:      api.PlatformBrowser,
		Target:        api.ES2022,
		JSX:           api.JSXAutomatic,
		Charset:       api.CharsetUTF8,
		LogLevel:      api.LogLevelSilent,
		Define:        map[string]string{"process.env.NODE_ENV": `"production"`},
		Loader: map[string]api.Loader{
			".png": api.LoaderDataURL, ".jpg": api.LoaderDataURL, ".jpeg": api.LoaderDataURL,
			".gif": api.LoaderDataURL, ".webp": api.LoaderDataURL, ".svg": api.LoaderDataURL,
			".woff2": api.LoaderDataURL, ".txt": api.LoaderText, ".csv": api.LoaderText,
		},
		Plugins: []api.Plugin{provided},
	})
	r := Result{Errors: messages(dir, res.Errors), Warnings: messages(dir, res.Warnings)}
	if len(r.Errors) > 0 {
		return r
	}
	size := 0
	for _, f := range res.OutputFiles {
		size += len(f.Contents)
		switch filepath.Ext(f.Path) {
		case ".js":
			r.JS = string(f.Contents)
		case ".css":
			r.CSS = string(f.Contents)
		}
	}
	if size > maxBundle {
		return Result{Errors: []string{fmt.Sprintf("the bundle is %d MB; the limit is %d MB", size>>20, maxBundle>>20)}}
	}
	if r.JS == "" {
		r.Errors = []string{"the build made no script"}
	}
	return r
}

func quoteAll(names []string) []string {
	out := make([]string, len(names))
	for i, n := range names {
		out[i] = regexp.QuoteMeta(n)
	}
	return out
}

// messages formats esbuild's messages as file:line:col: text.
func messages(dir string, msgs []api.Message) []string {
	out := make([]string, 0, len(msgs))
	for _, m := range msgs {
		text := m.Text
		if m.PluginName != "" {
			text = m.PluginName + ": " + text
		}
		if l := m.Location; l != nil {
			file := l.File
			if rel, err := filepath.Rel(dir, filepath.Join(dir, file)); err == nil {
				file = rel
			}
			text = fmt.Sprintf("%s:%d:%d: %s\n    %s", file, l.Line, l.Column+1, text, strings.TrimSpace(l.LineText))
			if l.Suggestion != "" {
				text += fmt.Sprintf("\n    (did you mean %q?)", l.Suggestion)
			}
		}
		for _, n := range m.Notes {
			if n.Text != "" {
				text += "\n    " + n.Text
			}
		}
		out = append(out, text)
	}
	sort.Strings(out)
	return out
}

// writeTypes writes .everywhere/types/everywhere.d.ts (and a .gitignore for
// it) in root, the .everywhere directory, when it's out of date.
func writeTypes(root string) {
	typesDir := filepath.Join(root, "types")
	path := filepath.Join(typesDir, "everywhere.d.ts")
	if b, err := os.ReadFile(path); err == nil && string(b) == Types {
		return
	}
	if err := os.MkdirAll(typesDir, 0o755); err != nil {
		return
	}
	_ = os.WriteFile(path, []byte(Types), 0o644)
	Gitignore(root)
}

// gitignore keeps what the daemon writes and processes keep out of git;
// dashboards' sources stay in.
const gitignore = "# Written by the everywhere daemon: what it writes, and processes' data.\ntypes/\nprocesses/\n"

// Gitignore writes .everywhere/.gitignore in root (the .everywhere
// directory), unless there's one the daemon didn't write.
func Gitignore(root string) {
	path := filepath.Join(root, ".gitignore")
	b, err := os.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil, string(b) == gitignore, !strings.HasPrefix(string(b), "# Written by the everywhere daemon"):
		return
	}
	if os.MkdirAll(root, 0o755) == nil {
		_ = os.WriteFile(path, []byte(gitignore), 0o644)
	}
}
