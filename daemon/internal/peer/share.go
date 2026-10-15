package peer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/conner-replogle/everywhere/daemon/internal/agent"
	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
)

// attachToolName is the tool a claude thread's agent shows the user files with.
const attachToolName = "attach_file"

// attachTools lets a thread's agent put files in front of the user, in the
// thread's chat: images and videos to look at there, anything else to
// download.
func (s *Server) attachTools() []mcp.Tool {
	return []mcp.Tool{{
		Name:  attachToolName,
		Title: "Attach files to the chat",
		Description: "Show the user files from this computer in this thread's chat in the everywhere app: images appear inline, videos play there, and any other file gets a card they can download. " +
			"Use it whenever the user should see or get a file you made or found: a screenshot, a screen recording, a generated image or chart, a PDF or report, a build, an export, a log. Telling them a path is not enough when they are on another device. " +
			fmt.Sprintf("Up to 10 files per call, each up to %d MB; paths are absolute or relative to the thread's directory. A copy is attached, so later changes to the file don't show. ", agent.MaxSharedBytes>>20) +
			"For a folder, attach the files in it or an archive of it.",
		InputSchema: json.RawMessage(`{"type": "object", "required": ["paths"], "properties": {
    "paths": {"type": "array", "minItems": 1, "maxItems": 10, "items": {"type": "string"}, "description": "Files to attach."},
    "caption": {"type": "string", "description": "A line shown with the files, e.g. what they are."}
  }}`),
		Annotations: mcp.Annotations{ReadOnly: true},
		Call: func(_ context.Context, c mcp.Caller, args json.RawMessage) (*mcp.Result, error) {
			if c.ThreadID == "" {
				return nil, errors.New("this session has no thread to attach files to")
			}
			var a struct {
				Paths   []string `json:"paths"`
				Caption string   `json:"caption"`
			}
			if err := json.Unmarshal(args, &a); err != nil {
				return nil, fmt.Errorf("invalid arguments: %w", err)
			}
			dir, worktree, err := s.store.ThreadWorkdir(c.ThreadID)
			if err != nil {
				return nil, err
			}
			if worktree != "" {
				dir = worktree
			}
			paths := make([]string, 0, len(a.Paths))
			for _, p := range a.Paths {
				paths = append(paths, resolvePath(dir, p))
			}
			atts, err := s.agents.ShareFiles(c.ThreadID, a.Caption, paths)
			if err != nil {
				return nil, err
			}
			names := make([]string, 0, len(atts))
			for _, at := range atts {
				names = append(names, fmt.Sprintf("%s (%s)", at.Name, at.Kind))
			}
			return mcp.Text("Attached to the chat: " + strings.Join(names, ", ") + "."), nil
		},
	}}
}

// resolvePath makes p absolute: ~ is the home directory, and a relative
// path is in dir.
func resolvePath(dir, p string) string {
	p = strings.TrimSpace(p)
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			p = filepath.Join(home, strings.TrimPrefix(p, "~"))
		}
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(dir, p)
	}
	return filepath.Clean(p)
}
