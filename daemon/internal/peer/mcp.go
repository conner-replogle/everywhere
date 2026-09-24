package peer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/conner-replogle/everywhere/daemon/internal/browser"
	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
)

// mcpName is the daemon's MCP server as claude knows it; its tools show up
// as mcp__everywhere__<tool>.
const mcpName = "everywhere"

// claudeArgs gives a claude thread's process the daemon's MCP server, with
// a token of its own, and lets it use the browser tools without asking.
// The config goes in a private file: on the command line, other users on
// the machine could read the token from the process list.
func (s *Server) claudeArgs(threadID, projectID string) ([]string, func(), error) {
	endpoint, token, revoke, err := s.mcp.Grant(mcp.Caller{ThreadID: threadID, ProjectID: projectID})
	if err != nil {
		return nil, nil, err
	}
	cfg, err := json.Marshal(map[string]any{"mcpServers": map[string]any{mcpName: map[string]any{
		"type":    "http",
		"url":     endpoint,
		"headers": map[string]string{"Authorization": "Bearer " + token},
	}}})
	if err != nil {
		revoke()
		return nil, nil, err
	}
	if err := os.MkdirAll(s.mcpDir, 0o700); err != nil {
		revoke()
		return nil, nil, err
	}
	f, err := os.CreateTemp(s.mcpDir, threadID+"-*.json")
	if err != nil {
		revoke()
		return nil, nil, err
	}
	path := f.Name()
	_, werr := f.Write(cfg)
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	release := func() {
		revoke()
		_ = os.Remove(path)
	}
	if werr != nil {
		release()
		return nil, nil, fmt.Errorf("writing mcp config: %w", werr)
	}
	allowed := make([]string, 0, len(browser.ToolNames()))
	for _, name := range browser.ToolNames() {
		allowed = append(allowed, "mcp__"+mcpName+"__"+name)
	}
	return []string{"--mcp-config", path, "--allowedTools", strings.Join(allowed, ",")}, release, nil
}

// clearMCPConfigs removes configs left by a daemon that didn't exit
// cleanly; their tokens died with it.
func clearMCPConfigs(dir string) {
	paths, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	for _, p := range paths {
		_ = os.Remove(p)
	}
}
