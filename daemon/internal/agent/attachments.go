package agent

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	if _, err := m.store.AgentThread(threadID); err != nil {
		return protocol.AgentAttachment{}, err
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
