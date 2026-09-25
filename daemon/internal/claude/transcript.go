package claude

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ErrNotInTranscript means a message isn't in the session's transcript.
var ErrNotInTranscript = errors.New("claude: message not in the session's transcript")

// ConfigDir is where claude keeps its state for a process started with env
// (nil: the daemon's own): $CLAUDE_CONFIG_DIR, or ~/.claude.
func ConfigDir(env []string) string {
	if env == nil {
		env = os.Environ()
	}
	for _, kv := range env {
		if v, ok := strings.CutPrefix(kv, "CLAUDE_CONFIG_DIR="); ok && v != "" {
			return v
		}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

// ForkPoint returns the transcript entry just before the message with the
// given UUID in a session: what Options.ResumeAt takes to roll the
// conversation back to before that message. "" means the message started
// the conversation, so nothing comes before it.
//
// Transcripts are claude's own files (<configDir>/projects/<dir>/<id>.jsonl),
// chained through parentUuid.
func ForkPoint(configDir, sessionID, messageUUID string) (string, error) {
	paths, _ := filepath.Glob(filepath.Join(configDir, "projects", "*", sessionID+".jsonl"))
	if len(paths) == 0 {
		return "", fmt.Errorf("claude: no transcript for session %s", sessionID)
	}
	f, err := os.Open(paths[0])
	if err != nil {
		return "", err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 64<<10)
	needle := []byte(messageUUID)
	for {
		line, err := r.ReadBytes('\n')
		// Most lines don't mention the message at all; skip decoding them.
		if bytes.Contains(line, needle) {
			var e struct {
				UUID       string  `json:"uuid"`
				ParentUUID *string `json:"parentUuid"`
			}
			if json.Unmarshal(line, &e) == nil && e.UUID == messageUUID {
				if e.ParentUUID == nil {
					return "", nil
				}
				return *e.ParentUUID, nil
			}
		}
		if err == io.EOF {
			return "", ErrNotInTranscript
		}
		if err != nil {
			return "", err
		}
	}
}
