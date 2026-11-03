// Command plugin-registry builds the plugin registry from the repo's
// plugins/ folder: it checks each plugin (its plugin.json, its web part),
// builds its program for every platform, packs an archive per platform and
// writes index.json, which the daemon reads (see external/catalog.go).
//
// A plugin whose version the published registry (-previous) already has is
// taken from there, not rebuilt: a published version never changes, so
// changing a plugin means bumping its version. Only new archives are
// written to -out, so CI uploads them and index.json without replacing any.
//
//	go run ./cmd/plugin-registry -plugins ../plugins -out ../dist -previous https://…/index.json
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/dashboard"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin/external"
)

// targets are the platforms programs are built for: where the daemon runs.
var targets = []string{"linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64", "windows-amd64", "windows-arm64"}

func main() {
	pluginsDir := flag.String("plugins", "../plugins", "the folder of plugins, one per directory")
	out := flag.String("out", "dist", "where to write index.json and new archives")
	previous := flag.String("previous", "", "the published index.json to keep versions from (a URL or file); none to build everything")
	homepage := flag.String("homepage", "https://github.com/conner-replogle/everywhere/tree/main/plugins/", "plugins' homepages, before their ids")
	check := flag.Bool("check", false, "only check the plugins: no builds for other platforms, nothing written")
	flag.Parse()
	if err := run(*pluginsDir, *out, *previous, *homepage, *check); err != nil {
		log.Fatal(err)
	}
}

func run(pluginsDir, out, previous, homepage string, check bool) error {
	pluginsDir, err := filepath.Abs(pluginsDir)
	if err != nil {
		return err
	}
	prev := external.Catalog{}
	if previous != "" {
		prev, err = readPrevious(previous)
		if err != nil {
			return err
		}
	}
	if !check {
		if err := os.MkdirAll(out, 0o755); err != nil {
			return err
		}
	}
	entries, err := os.ReadDir(pluginsDir)
	if err != nil {
		return err
	}
	idx := external.Catalog{API: external.CatalogAPI, Updated: time.Now().UTC().Format(time.RFC3339), Plugins: []external.CatalogEntry{}}
	var errs []error
	for _, d := range entries {
		dir := filepath.Join(pluginsDir, d.Name())
		if _, err := os.Stat(filepath.Join(dir, external.ManifestFile)); !d.IsDir() || err != nil {
			continue
		}
		e, err := buildPlugin(dir, out, prev, homepage, check)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", d.Name(), err))
			continue
		}
		idx.Plugins = append(idx.Plugins, e)
	}
	if err := errors.Join(errs...); err != nil {
		return err
	}
	sort.Slice(idx.Plugins, func(i, j int) bool { return idx.Plugins[i].Manifest.ID < idx.Plugins[j].Manifest.ID })
	if check {
		fmt.Printf("%d plugins check out.\n", len(idx.Plugins))
		return nil
	}
	b, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(out, "index.json"), append(b, '\n'), 0o644)
}

func readPrevious(src string) (external.Catalog, error) {
	if !strings.Contains(src, "://") {
		src = "file://" + src
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	cat, err := external.FetchCatalog(ctx, src, true)
	if err != nil && strings.Contains(err.Error(), "404") {
		// Nothing published yet.
		return external.Catalog{API: external.CatalogAPI}, nil
	}
	return cat, err
}

func buildPlugin(dir, out string, prev external.Catalog, homepage string, check bool) (external.CatalogEntry, error) {
	m, err := external.ReadManifest(dir)
	if err != nil {
		return external.CatalogEntry{}, err
	}
	if filepath.Base(dir) != m.ID {
		return external.CatalogEntry{}, fmt.Errorf("its folder is named %q but its id is %q", filepath.Base(dir), m.ID)
	}
	if m.Version == "" {
		return external.CatalogEntry{}, errors.New("give it a version")
	}
	if m.Web != "" {
		r := dashboard.NewBuilder().BuildWithTypes(filepath.Join(dir, m.Web), mustTemp())
		if len(r.Errors) > 0 {
			return external.CatalogEntry{}, fmt.Errorf("its web part: %s", strings.Join(r.Errors, "; "))
		}
	}
	isGo := hasGo(dir)
	if isGo {
		// Vet it here, so a broken plugin fails before the cross builds.
		if err := goCmd(dir, nil, "vet", "."); err != nil {
			return external.CatalogEntry{}, err
		}
	}
	if old, ok := prev.Find(m.ID); ok && old.Manifest.Version == m.Version {
		if !sameJSON(old.Manifest, m) {
			return external.CatalogEntry{}, fmt.Errorf("version %s is published with another plugin.json: bump its version", m.Version)
		}
		fmt.Printf("%s %s: published already\n", m.ID, m.Version)
		return old, nil
	}
	e := external.CatalogEntry{Manifest: m, Icon: external.IconData(dir, m), Homepage: homepage + m.ID, Artifacts: map[string]external.Artifact{}}
	if check {
		return e, nil
	}
	if !m.HasProcess() || !isGo {
		// Nothing to build for each platform: a script, or no program at all.
		a, err := packArtifact(dir, nil, out, fmt.Sprintf("%s-%s-any.tar.gz", m.ID, m.Version))
		if err != nil {
			return e, err
		}
		e.Artifacts["any"] = a
		return e, nil
	}
	prog := filepath.Clean(m.Command[0])
	if filepath.IsAbs(prog) || strings.Contains(prog, string(filepath.Separator)) || strings.HasPrefix(prog, "..") {
		return e, fmt.Errorf("its command %q: name a program in its folder (./%s)", m.Command[0], m.ID)
	}
	for _, t := range targets {
		goos, goarch, _ := strings.Cut(t, "-")
		bin := prog
		if goos == "windows" {
			bin += ".exe"
		}
		a, err := packArtifact(dir, func(stage string) error {
			return goCmd(dir, []string{"GOOS=" + goos, "GOARCH=" + goarch, "CGO_ENABLED=0"},
				"build", "-trimpath", "-ldflags=-s -w", "-o", filepath.Join(stage, bin), ".")
		}, out, fmt.Sprintf("%s-%s-%s.tar.gz", m.ID, m.Version, t))
		if err != nil {
			return e, fmt.Errorf("%s: %w", t, err)
		}
		e.Artifacts[t] = a
	}
	fmt.Printf("%s %s: built for %s\n", m.ID, m.Version, strings.Join(targets, ", "))
	return e, nil
}

// packArtifact stages the plugin's files (and what build adds), packs them
// as out/name and says what the index lists for it.
func packArtifact(dir string, build func(stage string) error, out, name string) (external.Artifact, error) {
	stage := mustTemp()
	defer os.RemoveAll(stage)
	if err := stageFiles(dir, stage); err != nil {
		return external.Artifact{}, err
	}
	if build != nil {
		if err := build(stage); err != nil {
			return external.Artifact{}, err
		}
	}
	var buf bytes.Buffer
	if err := external.Pack(stage, &buf); err != nil {
		return external.Artifact{}, err
	}
	if err := os.WriteFile(filepath.Join(out, name), buf.Bytes(), 0o644); err != nil {
		return external.Artifact{}, err
	}
	sum := sha256.Sum256(buf.Bytes())
	return external.Artifact{URL: name, SHA256: hex.EncodeToString(sum[:]), Size: int64(buf.Len())}, nil
}

// stageFiles copies what the plugin ships (see external.PackSkips) to stage,
// leaving out a program built by hand in its folder.
func stageFiles(dir, stage string) error {
	return filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		if rel == "." {
			return nil
		}
		if external.PackSkips(rel, d.IsDir()) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		target := filepath.Join(stage, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("%s isn't a regular file", rel)
		}
		if info.Mode()&0o111 != 0 && !strings.Contains(rel, string(filepath.Separator)) && hasGo(dir) {
			return nil // a local build of its program
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
		if err != nil {
			return err
		}
		if _, err := io.Copy(f, in); err != nil {
			f.Close()
			return err
		}
		return f.Close()
	})
}

func hasGo(dir string) bool {
	files, _ := filepath.Glob(filepath.Join(dir, "*.go"))
	return slices.ContainsFunc(files, func(f string) bool { return !strings.HasSuffix(f, "_test.go") })
}

func goCmd(dir string, env []string, args ...string) error {
	cmd := exec.Command("go", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("go %s: %w", strings.Join(args, " "), err)
	}
	return nil
}

func sameJSON(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

func mustTemp() string {
	d, err := os.MkdirTemp("", "plugin-registry-")
	if err != nil {
		log.Fatal(err)
	}
	return d
}
