// Package update replaces the running binary with the latest GitHub release.
package update

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
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
	bin, err := extract(archive, "everywhere")
	if err != nil {
		return err
	}
	tmp := filepath.Join(filepath.Dir(exe), ".everywhere.new")
	if err := os.WriteFile(tmp, bin, 0o755); err != nil {
		return err
	}
	return os.Rename(tmp, exe)
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
