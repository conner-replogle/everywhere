package external

// The catalog: installing plugins from a registry, an index.json listing
// each plugin's manifest and an archive per platform (see cmd/plugin-registry,
// which builds it from the repo's plugins/ folder, and PLUGINS.md).
//
// An archive is only installed if its sha256 is the index's and its
// plugin.json is the one the index showed, so what the user agreed to (its
// permissions and tools) is what runs.

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
)

// DefaultRegistry is the registry this repo's CI publishes, as assets of a
// prerelease (so the daemon's own updates never mistake it for a release).
const DefaultRegistry = "https://github.com/conner-replogle/everywhere/releases/download/plugins/index.json"

// RegistryURL is the registry to use: EVERYWHERE_PLUGIN_REGISTRY, or DefaultRegistry.
func RegistryURL() string {
	if u := strings.TrimSpace(os.Getenv("EVERYWHERE_PLUGIN_REGISTRY")); u != "" {
		return u
	}
	return DefaultRegistry
}

// Catalog is a registry's index.json.
type Catalog struct {
	// API is the index format's revision.
	API     int            `json:"api"`
	Updated string         `json:"updated,omitempty"`
	Plugins []CatalogEntry `json:"plugins"`
}

// CatalogAPI is the index format this daemon reads.
const CatalogAPI = 1

// CatalogEntry is one plugin's newest version.
type CatalogEntry struct {
	Manifest Manifest `json:"manifest"`
	// Icon is its logo as a data: URL, to show before it's installed.
	Icon string `json:"icon,omitempty"`
	// Homepage is where to read about it (its folder in the repo).
	Homepage string `json:"homepage,omitempty"`
	// Artifacts are its archives by platform ("linux-amd64"…), or one for
	// "any" when it has no program of its own to build.
	Artifacts map[string]Artifact `json:"artifacts"`
}

// Artifact is an archive (.tar.gz) of the installed plugin's directory.
type Artifact struct {
	// URL is absolute, or relative to the index's.
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Platform is this machine's artifact key.
func Platform() string { return runtime.GOOS + "-" + runtime.GOARCH }

// Artifact is the entry's archive for this machine, if it has one.
func (e CatalogEntry) Artifact() (Artifact, bool) {
	if a, ok := e.Artifacts[Platform()]; ok {
		return a, true
	}
	a, ok := e.Artifacts["any"]
	return a, ok
}

// Problem is why the entry can't be installed here, or "".
func (e CatalogEntry) Problem() string {
	if e.Manifest.API != plugin.API {
		return fmt.Sprintf("built for plugin API %d; this daemon has %d (update everywhere)", e.Manifest.API, plugin.API)
	}
	if _, ok := e.Artifact(); !ok {
		return "not built for " + Platform()
	}
	return ""
}

// LocalConsent lists the permissions of the entry that only the device's
// own CLI may grant (plugin.LocalConsent).
func (e CatalogEntry) LocalConsent() []string {
	var out []string
	for _, p := range e.Manifest.Permissions {
		for _, lc := range plugin.LocalConsent {
			if p == lc {
				out = append(out, p)
			}
		}
	}
	return out
}

const (
	maxCatalog = 8 << 20
	maxArchive = 200 << 20
	// maxUnpacked bounds an archive's unpacked size.
	maxUnpacked = 500 << 20
)

var downloads = &http.Client{Timeout: 5 * time.Minute}

var catalogCache struct {
	sync.Mutex
	url string
	at  time.Time
	idx Catalog
}

// FetchCatalog reads the registry's index, from a cache for a few minutes unless
// fresh is set.
func FetchCatalog(ctx context.Context, url string, fresh bool) (Catalog, error) {
	catalogCache.Lock()
	if !fresh && catalogCache.url == url && time.Since(catalogCache.at) < 5*time.Minute {
		idx := catalogCache.idx
		catalogCache.Unlock()
		return idx, nil
	}
	catalogCache.Unlock()
	raw, err := download(ctx, url, maxCatalog)
	if err != nil {
		return Catalog{}, fmt.Errorf("the plugin registry: %w", err)
	}
	var idx Catalog
	if err := json.Unmarshal(raw, &idx); err != nil {
		return Catalog{}, fmt.Errorf("the plugin registry's index: %w", err)
	}
	if idx.API != CatalogAPI {
		return Catalog{}, fmt.Errorf("the plugin registry's index is format %d; this daemon reads %d (update everywhere)", idx.API, CatalogAPI)
	}
	catalogCache.Lock()
	catalogCache.url, catalogCache.at, catalogCache.idx = url, time.Now(), idx
	catalogCache.Unlock()
	return idx, nil
}

// Find is the index's entry for id.
func (idx Catalog) Find(id string) (CatalogEntry, bool) {
	for _, e := range idx.Plugins {
		if e.Manifest.ID == id {
			return e, true
		}
	}
	return CatalogEntry{}, false
}

func download(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if strings.HasPrefix(url, "file://") {
		return os.ReadFile(strings.TrimPrefix(url, "file://"))
	}
	res, err := downloads.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %s", req.URL.Host, res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("it's over %d MB", limit>>20)
	}
	return b, nil
}

// artifactURL makes an artifact's URL absolute against the index's.
func artifactURL(indexURL, u string) string {
	if strings.Contains(u, "://") {
		return u
	}
	return indexURL[:strings.LastIndex(indexURL, "/")+1] + strings.TrimPrefix(u, "./")
}

// RegistrySource is how a plugin was installed from a registry, kept in its
// directory as RegistrySourceFile.
type RegistrySource struct {
	Registry string `json:"registry"`
	Version  string `json:"version"`
	SHA256   string `json:"sha256"`
}

// RegistrySourceFile is where an installed plugin's RegistrySource is kept.
const RegistrySourceFile = ".registry.json"

// InstalledFrom is how the plugin in dir was installed, if from a registry.
func InstalledFrom(dir string) (RegistrySource, bool) {
	var s RegistrySource
	raw, err := os.ReadFile(filepath.Join(dir, RegistrySourceFile))
	return s, err == nil && json.Unmarshal(raw, &s) == nil
}

// InstallFrom downloads the entry's archive for this machine and installs it
// under root (replacing what's there), checking it against the index.
// It doesn't turn the plugin on.
func InstallFrom(ctx context.Context, indexURL string, e CatalogEntry, root string) error {
	if p := e.Problem(); p != "" {
		return errors.New(p)
	}
	a, _ := e.Artifact()
	if a.Size > maxArchive {
		return fmt.Errorf("its archive is over %d MB", maxArchive>>20)
	}
	b, err := download(ctx, artifactURL(indexURL, a.URL), maxArchive)
	if err != nil {
		return fmt.Errorf("downloading %s: %w", e.Manifest.ID, err)
	}
	sum := sha256.Sum256(b)
	if !strings.EqualFold(hex.EncodeToString(sum[:]), a.SHA256) {
		return fmt.Errorf("%s's download doesn't match the registry's checksum", e.Manifest.ID)
	}
	id := e.Manifest.ID
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	// Unpacked beside root, not in it, so the manager never sees it half
	// done; on the same filesystem, so it can be renamed into place.
	tmp, err := os.MkdirTemp(filepath.Dir(root), ".plugin-"+id+"-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	if err := Unpack(bytes.NewReader(b), tmp); err != nil {
		return fmt.Errorf("unpacking %s: %w", id, err)
	}
	m, err := ReadManifest(tmp)
	if err != nil {
		return err
	}
	if !sameManifest(m, e.Manifest) {
		return fmt.Errorf("%s's archive has a different plugin.json than the registry shows", id)
	}
	src, _ := json.Marshal(RegistrySource{Registry: indexURL, Version: m.Version, SHA256: a.SHA256})
	if err := os.WriteFile(filepath.Join(tmp, RegistrySourceFile), src, 0o644); err != nil {
		return err
	}
	return SwapDir(tmp, filepath.Join(root, id))
}

// SwapDir puts the directory src in dst's place, as near atomically as the
// platform allows.
func SwapDir(src, dst string) error {
	old := filepath.Join(filepath.Dir(dst), "."+filepath.Base(dst)+".old")
	_ = os.RemoveAll(old)
	if _, err := os.Stat(dst); err == nil {
		if err := os.Rename(dst, old); err != nil {
			return err
		}
	}
	if err := os.Rename(src, dst); err != nil {
		_ = os.Rename(old, dst)
		return err
	}
	_ = os.RemoveAll(old)
	return nil
}

// Unpack extracts a .tar.gz into dir: regular files and directories only,
// all inside dir.
func Unpack(r io.Reader, dir string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	var total int64
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		name := filepath.Clean(filepath.FromSlash(h.Name))
		if name == "." {
			continue
		}
		if filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, ".."+string(filepath.Separator)) {
			return fmt.Errorf("%q is outside the plugin", h.Name)
		}
		target := filepath.Join(dir, name)
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			total += h.Size
			if total > maxUnpacked {
				return fmt.Errorf("it unpacks to over %d MB", maxUnpacked>>20)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			mode := os.FileMode(0o644)
			if h.FileInfo().Mode()&0o111 != 0 {
				mode = 0o755
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, io.LimitReader(tr, h.Size)); err != nil {
				f.Close()
				return err
			}
			if err := f.Close(); err != nil {
				return err
			}
		default:
			return fmt.Errorf("%q isn't a file or directory", h.Name)
		}
	}
}

// Pack writes dir as a .tar.gz, leaving out what only building it needs:
// Go sources, tests, modules, node_modules, the API types the daemon writes.
func Pack(dir string, w io.Writer) error {
	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil || rel == "." {
			return err
		}
		if PackSkips(rel, d.IsDir()) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !d.IsDir() && !info.Mode().IsRegular() {
			return fmt.Errorf("%s isn't a regular file", rel)
		}
		h, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		h.Name = filepath.ToSlash(rel)
		h.Uname, h.Gname, h.Uid, h.Gid = "", "", 0, 0
		h.ModTime = time.Unix(0, 0)
		if d.IsDir() {
			h.Name += "/"
		}
		if err := tw.WriteHeader(h); err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(tw, f)
		return err
	})
	if err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

// PackSkips says whether a plugin's file (by its path in the plugin) is left out
// of its archive.
func PackSkips(rel string, dir bool) bool {
	base := filepath.Base(rel)
	if dir {
		return base == "node_modules" || base == ".git" || rel == "types"
	}
	switch {
	case strings.HasSuffix(base, ".go"), base == "go.mod", base == "go.sum",
		base == ".gitignore", base == ".DS_Store", base == RegistrySourceFile:
		return true
	}
	return false
}
