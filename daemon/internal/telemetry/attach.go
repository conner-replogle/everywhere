package telemetry

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// maxAttach caps one uploaded file.
const maxAttach = 200 << 20

// Files is where attachments are kept in a project.
const Files = ".everywhere/files"

var unsafePath = strings.NewReplacer("/", "_", "\\", "_", ":", "_", "#", "_", " ", "_", "..", "_")

// Attachment is an "attachment" event's data.
type Attachment struct {
	// Path is relative to the project.
	Path    string   `json:"path"`
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	Size    int64    `json:"size"`
	Step    *float64 `json:"step,omitempty"`
	Caption string   `json:"caption,omitempty"`
}

// handleAttach keeps an uploaded file in the project and logs it as an
// "attachment" event of the run.
func (h *Hub) handleAttach(w http.ResponseWriter, r *http.Request) {
	info := h.token(r)
	if info == nil {
		http.Error(w, "unknown token", http.StatusUnauthorized)
		return
	}
	q := r.URL.Query()
	name := filepath.Base(strings.TrimSpace(q.Get("name")))
	if name == "" || name == "." || name == "/" {
		http.Error(w, "give the file's name: /attach?name=sample.png", http.StatusBadRequest)
		return
	}
	a := Attachment{Name: name, Caption: q.Get("caption")}
	if s := q.Get("step"); s != "" {
		v, err := strconv.ParseFloat(s, 64)
		if err != nil {
			http.Error(w, "step: "+err.Error(), http.StatusBadRequest)
			return
		}
		a.Step = &v
	}
	a.Type = mime.TypeByExtension(filepath.Ext(name))
	if a.Type == "" {
		a.Type = r.Header.Get("Content-Type")
	}
	if a.Type == "" {
		a.Type = "application/octet-stream"
	}

	id := make([]byte, 4)
	_, _ = rand.Read(id)
	rel := filepath.Join(Files, unsafePath.Replace(info.Experiment), unsafePath.Replace(info.Run),
		fmt.Sprintf("%d-%s-%s", now(), hex.EncodeToString(id), unsafePath.Replace(name)))
	full := filepath.Join(info.Home, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	f, err := os.Create(full)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	n, err := io.Copy(f, http.MaxBytesReader(w, r.Body, maxAttach))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = os.Remove(full)
		http.Error(w, fmt.Sprintf("upload (at most %d MB): %v", maxAttach>>20, err), http.StatusRequestEntityTooLarge)
		return
	}
	a.Path, a.Size = filepath.ToSlash(rel), n
	data, _ := json.Marshal(a)
	h.add(info.Home, nil, []Event{{Experiment: info.Experiment, Run: info.Run, TS: now(), Kind: "attachment", Data: data}})
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"path": a.Path})
}

// File finds an attachment (or any file) in a project for a viewer: path is
// relative to the project and must stay inside it.
func File(home, path string) (string, os.FileInfo, error) {
	root, err := filepath.EvalSymlinks(home)
	if err != nil {
		return "", nil, err
	}
	full := path
	if !filepath.IsAbs(full) {
		full = filepath.Join(home, path)
	}
	real, err := filepath.EvalSymlinks(full)
	if err != nil {
		return "", nil, fmt.Errorf("%s: no such file", path)
	}
	if rel, err := filepath.Rel(root, real); err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", nil, fmt.Errorf("%s is outside the project", path)
	}
	fi, err := os.Stat(real)
	if err != nil {
		return "", nil, err
	}
	if fi.IsDir() {
		return "", nil, fmt.Errorf("%s is a directory", path)
	}
	return real, fi, nil
}
