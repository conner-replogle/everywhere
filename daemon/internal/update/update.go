// Package update replaces the running binary with the latest GitHub release.
package update

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/version"
)

var httpClient = &http.Client{Timeout: 2 * time.Minute}

// Latest downloads the latest release for this platform, verifies its
// checksum, and atomically replaces the binary at exe.
func Latest(exe string) error {
	asset := fmt.Sprintf("everywhere_%s_%s.tar.gz", runtime.GOOS, runtime.GOARCH)
	base := "https://github.com/" + version.Repo + "/releases/latest/download/"

	sums, err := fetch(base + "checksums.txt")
	if err != nil {
		return err
	}
	want := ""
	sc := bufio.NewScanner(strings.NewReader(string(sums)))
	for sc.Scan() {
		if f := strings.Fields(sc.Text()); len(f) == 2 && f[1] == asset {
			want = f[0]
		}
	}
	if want == "" {
		return fmt.Errorf("no checksum for %s in latest release", asset)
	}
	archive, err := fetch(base + asset)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(archive)
	if hex.EncodeToString(sum[:]) != want {
		return fmt.Errorf("checksum mismatch for %s", asset)
	}
	return install(exe, archive)
}

// install puts the release archive's binaries in place of exe.
func install(exe string, archive []byte) error {
	bin, err := extract(archive, "everywhere")
	if err != nil {
		return err
	}
	// Linux releases also carry the remote desktop worker, which must match
	// the daemon; it goes next to it.
	worker, err := extract(archive, WorkerName)
	if err == nil {
		if err := replace(filepath.Join(filepath.Dir(exe), WorkerName), worker); err != nil {
			return fmt.Errorf("installing %s: %w", WorkerName, err)
		}
	}
	return replace(exe, bin)
}

// WorkerName is the remote desktop worker in Linux release archives.
const WorkerName = "everywhere-desktop"

// replace atomically writes an executable at path.
func replace(path string, data []byte) error {
	tmp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".new")
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// LatestVersion returns the newest release's version, e.g. "0.1.2", without
// downloading it: GitHub redirects /releases/latest to the release's tag,
// which avoids the rate-limited API.
func LatestVersion(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, "https://github.com/"+version.Repo+"/releases/latest", nil)
	if err != nil {
		return "", err
	}
	client := &http.Client{
		Timeout:       15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	resp.Body.Close()
	loc := resp.Header.Get("Location")
	if resp.StatusCode/100 != 3 || !strings.Contains(loc, "/releases/tag/") {
		return "", fmt.Errorf("finding the latest release: unexpected %s", resp.Status)
	}
	return strings.TrimPrefix(path.Base(loc), "v"), nil
}

// Newer reports whether version a is newer than b. Versions are dotted
// numbers with an optional "v"; anything unparsable (like "dev") is never
// newer and never older.
func Newer(a, b string) bool {
	pa, oka := parse(a)
	pb, okb := parse(b)
	if !oka || !okb {
		return false
	}
	for i := range max(len(pa), len(pb)) {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

func parse(v string) ([]int, bool) {
	v, _, _ = strings.Cut(strings.TrimPrefix(v, "v"), "-") // drop pre-release suffixes
	var out []int
	for _, part := range strings.Split(v, ".") {
		n, err := strconv.Atoi(part)
		if err != nil {
			return nil, false
		}
		out = append(out, n)
	}
	return out, true
}

func fetch(url string) ([]byte, error) {
	resp, err := httpClient.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	return io.ReadAll(resp.Body)
}

func extract(archive []byte, name string) ([]byte, error) {
	gz, err := gzip.NewReader(strings.NewReader(string(archive)))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil, fmt.Errorf("%s not found in archive", name)
		}
		if err != nil {
			return nil, err
		}
		if filepath.Base(h.Name) == name && h.Typeflag == tar.TypeReg {
			return io.ReadAll(tr)
		}
	}
}
