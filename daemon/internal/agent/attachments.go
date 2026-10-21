package agent

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/conner-replogle/everywhere/daemon/internal/claude"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// Limits follow t3code's.
const (
	MaxImageBytes      = 10 << 20
	MaxFileBytes       = 50 << 20
	maxAttachmentsSent = 20
)

// imageTypes are the media types claude accepts as image blocks.
var imageTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

var uploadID = regexp.MustCompile(`^[a-z0-9]{8,64}$`)

// attachmentStore keeps uploaded files at <root>/<threadID>/<id>/<name>, with
// their metadata next to them.
type attachmentStore struct {
	root string
}

type storedAttachment struct {
	protocol.AgentAttachment
	Path string
}

// dir is the thread's attachment directory, created if needed. claude is
// given access to it.
func (a attachmentStore) dir(threadID string) (string, error) {
	d := filepath.Join(a.root, threadID)
	return d, os.MkdirAll(d, 0o700)
}

// remove deletes all of a thread's attachments.
func (a attachmentStore) remove(threadID string) error {
	return os.RemoveAll(filepath.Join(a.root, threadID))
}

// SaveUpload stores one uploaded file for a thread. r must yield exactly
// size bytes.
func (m *Manager) SaveUpload(threadID, id, name, mediaType string, size int64, r io.Reader) (protocol.AgentAttachment, error) {
	if !uploadID.MatchString(id) {
		return protocol.AgentAttachment{}, errors.New("bad upload id")
	}
	if a, err := m.store.AgentThread(threadID); err != nil {
		return protocol.AgentAttachment{}, err
	} else if !IsAgentKind(a.Kind) {
		return protocol.AgentAttachment{}, fmt.Errorf("thread %s is a %s thread", threadID, a.Kind)
	}
	name = cleanName(name)
	kind := "file"
	if imageTypes[mediaType] {
		kind = "image"
	}
	limit := int64(MaxFileBytes)
	if kind == "image" {
		limit = MaxImageBytes
	}
	if size <= 0 || size > limit {
		return protocol.AgentAttachment{}, fmt.Errorf("%s is %d bytes; the limit for a %s is %d MB", name, size, kind, limit>>20)
	}

	base, err := m.attachments.dir(threadID)
	if err != nil {
		return protocol.AgentAttachment{}, err
	}
	dir := filepath.Join(base, id)
	if err := os.Mkdir(dir, 0o700); err != nil {
		return protocol.AgentAttachment{}, fmt.Errorf("upload %s: %w", id, err)
	}
	ok := false
	defer func() {
		if !ok {
			os.RemoveAll(dir)
		}
	}()
	f, err := os.OpenFile(filepath.Join(dir, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return protocol.AgentAttachment{}, err
	}
	n, err := io.Copy(f, io.LimitReader(r, size+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return protocol.AgentAttachment{}, err
	}
	if n != size {
		return protocol.AgentAttachment{}, fmt.Errorf("upload %s: got %d bytes, expected %d", name, n, size)
	}
	att := protocol.AgentAttachment{ID: id, Name: name, Kind: kind, MediaType: mediaType, Size: size}
	meta, _ := json.Marshal(att)
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), meta, 0o600); err != nil {
		return protocol.AgentAttachment{}, err
	}
	ok = true
	return att, nil
}

// resolve looks up finished uploads by id.
func (a attachmentStore) resolve(threadID string, ids []string) ([]storedAttachment, error) {
	if len(ids) > maxAttachmentsSent {
		return nil, fmt.Errorf("at most %d attachments per message", maxAttachmentsSent)
	}
	out := make([]storedAttachment, 0, len(ids))
	for _, id := range ids {
		if !uploadID.MatchString(id) {
			return nil, errors.New("bad attachment id")
		}
		dir := filepath.Join(a.root, threadID, id)
		raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
		if err != nil {
			return nil, fmt.Errorf("attachment %s isn't uploaded (or was removed)", id)
		}
		var s storedAttachment
		if err := json.Unmarshal(raw, &s.AgentAttachment); err != nil {
			return nil, err
		}
		s.Path = filepath.Join(dir, s.Name)
		out = append(out, s)
	}
	return out, nil
}

// promptContent builds a prompt: images as image blocks ahead of the text,
// and a line per attachment saying where it's saved, so claude can open
// files it can't see inline (t3code's wording).
func promptContent(text string, files []storedAttachment) ([]claude.ContentBlock, error) {
	var blocks []claude.ContentBlock
	var notes []string
	for _, f := range files {
		if f.Kind == "image" {
			data, err := os.ReadFile(f.Path)
			if err != nil {
				return nil, err
			}
			blocks = append(blocks, claude.Image(f.MediaType, base64.StdEncoding.EncodeToString(data)))
		}
		notes = append(notes, fmt.Sprintf("[Attached %s %q is saved at: %s]", f.Kind, f.Name, f.Path))
	}
	if len(notes) > 0 {
		text = strings.TrimSpace(text + "\n\n" + strings.Join(notes, "\n"))
	}
	return append(blocks, claude.Text(text)), nil
}

// cleanName makes an uploaded file name safe to use as a path element.
func cleanName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, name)
	if name == "" || name == "." || name == ".." || name == "meta.json" {
		name = "attachment"
	}
	if r := []rune(name); len(r) > 200 {
		name = string(r[len(r)-200:])
	}
	return name
}

// MaxSharedBytes bounds each file an agent shares with attach_file: the
// browser holds the whole file to show it.
const MaxSharedBytes = 200 << 20

// maxShared is how many files one attach_file call takes.
const maxShared = 10

// ShareFiles copies files from the device into a thread's attachments and
// shows them in its timeline (attach_file): images and videos to look at,
// anything else to download. The copies outlive the originals, so what the
// user sees stays what the agent meant, and go when the thread is deleted.
// paths must be absolute.
func (m *Manager) ShareFiles(threadID, caption string, paths []string) ([]protocol.AgentAttachment, error) {
	if len(paths) == 0 {
		return nil, errors.New("give at least one file")
	}
	if len(paths) > maxShared {
		return nil, fmt.Errorf("at most %d files at a time", maxShared)
	}
	s, err := m.session(threadID)
	if err != nil {
		return nil, err
	}
	base, err := m.attachments.dir(threadID)
	if err != nil {
		return nil, err
	}
	var atts []protocol.AgentAttachment
	var made []string
	ok := false
	defer func() {
		if !ok {
			for _, d := range made {
				os.RemoveAll(d)
			}
		}
	}()
	for _, p := range paths {
		info, err := os.Stat(p)
		if err != nil {
			return nil, err
		}
		if info.IsDir() {
			return nil, fmt.Errorf("%s is a folder; attach the files in it, or an archive of it", p)
		}
		if info.Size() > MaxSharedBytes {
			return nil, fmt.Errorf("%s is %d MB; the limit is %d MB", p, info.Size()>>20, MaxSharedBytes>>20)
		}
		id := newUploadID()
		dir := filepath.Join(base, id)
		if err := os.Mkdir(dir, 0o700); err != nil {
			return nil, err
		}
		made = append(made, dir)
		name := cleanName(filepath.Base(p))
		dst := filepath.Join(dir, name)
		if err := copyFile(p, dst); err != nil {
			return nil, fmt.Errorf("copy %s: %w", p, err)
		}
		mediaType, kind := sharedKind(name)
		att := protocol.AgentAttachment{ID: id, Name: name, Kind: kind, MediaType: mediaType, Size: info.Size(), Path: dst}
		meta, _ := json.Marshal(att)
		if err := os.WriteFile(filepath.Join(dir, "meta.json"), meta, 0o600); err != nil {
			return nil, err
		}
		atts = append(atts, att)
	}
	ran := false
	s.call(func() {
		ran = true
		s.emit(protocol.AgentEvent{Type: "files", Text: strings.TrimSpace(caption), Attachments: atts})
	})
	if !ran {
		return nil, errClosed
	}
	ok = true
	return atts, nil
}

// sharedKind is a shared file's media type, and whether the timeline shows
// it as an image, plays it as a video, or offers it to download.
func sharedKind(name string) (mediaType, kind string) {
	ext := strings.ToLower(filepath.Ext(name))
	mediaType = mediaTypes[ext]
	if mediaType == "" {
		mediaType = mime.TypeByExtension(ext)
	}
	if i := strings.IndexByte(mediaType, ';'); i >= 0 {
		mediaType = mediaType[:i]
	}
	switch {
	case mediaType == "":
		return "application/octet-stream", "file"
	case strings.HasPrefix(mediaType, "image/"):
		return mediaType, "image"
	case strings.HasPrefix(mediaType, "video/"):
		return mediaType, "video"
	}
	return mediaType, "file"
}

// mediaTypes are the ones the timeline shows, whatever this machine's own
// MIME table knows (Go's built-in one lacks video).
var mediaTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".bmp": "image/bmp",
	".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
	".mkv": "video/x-matroska", ".ogv": "video/ogg",
	".pdf": "application/pdf",
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, io.LimitReader(in, MaxSharedBytes+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}

// newUploadID is an attachment id, as the web app makes for uploads.
func newUploadID() string {
	return strings.ReplaceAll(newUUID(), "-", "")
}

// maxResultImages bounds the images kept from one tool result.
const maxResultImages = 8

// saveResultImages keeps the images in a tool result (a Read of an image, a
// screenshot) as attachments, so the timeline can show what claude saw
// rather than "[image]". Images that can't be kept are left out.
func (m *Manager) saveResultImages(threadID string, content json.RawMessage) []protocol.AgentAttachment {
	var blocks []struct {
		Type   string `json:"type"`
		Source struct {
			Type      string `json:"type"`
			MediaType string `json:"media_type"`
			Data      string `json:"data"`
		} `json:"source"`
	}
	if json.Unmarshal(content, &blocks) != nil {
		return nil
	}
	var out []protocol.AgentAttachment
	for _, b := range blocks {
		if b.Type != "image" || b.Source.Type != "base64" || len(out) >= maxResultImages {
			continue
		}
		data, err := base64.StdEncoding.DecodeString(b.Source.Data)
		if err != nil || len(data) == 0 || len(data) > MaxImageBytes {
			continue
		}
		att, err := m.saveImage(threadID, b.Source.MediaType, data, len(out)+1)
		if err != nil {
			slog.Warn("keep tool result image", "thread", threadID, "err", err)
			continue
		}
		out = append(out, att)
	}
	return out
}

// saveImage stores image bytes as one of a thread's attachments.
func (m *Manager) saveImage(threadID, mediaType string, data []byte, n int) (protocol.AgentAttachment, error) {
	base, err := m.attachments.dir(threadID)
	if err != nil {
		return protocol.AgentAttachment{}, err
	}
	id := newUploadID()
	dir := filepath.Join(base, id)
	if err := os.Mkdir(dir, 0o700); err != nil {
		return protocol.AgentAttachment{}, err
	}
	ext := ".png"
	if exts, _ := mime.ExtensionsByType(mediaType); len(exts) > 0 {
		ext = exts[0]
	}
	switch mediaType {
	case "image/jpeg":
		ext = ".jpg"
	case "image/png":
		ext = ".png"
	}
	name := fmt.Sprintf("image-%d%s", n, ext)
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		os.RemoveAll(dir)
		return protocol.AgentAttachment{}, err
	}
	att := protocol.AgentAttachment{ID: id, Name: name, Kind: "image", MediaType: mediaType, Size: int64(len(data)), Path: path}
	meta, _ := json.Marshal(att)
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), meta, 0o600); err != nil {
		os.RemoveAll(dir)
		return protocol.AgentAttachment{}, err
	}
	return att, nil
}
