package peer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/conner-replogle/everywhere/daemon/internal/browser"
	"github.com/conner-replogle/everywhere/daemon/internal/desktop"
	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
	"github.com/conner-replogle/everywhere/daemon/internal/process"
)

// mcpName is the daemon's MCP server as claude knows it; its tools show up
// as mcp__everywhere__<tool>.
const mcpName = "everywhere"

// claudeArgs gives a claude thread's process the daemon's MCP server, with
// a token of its own, and lets it use the browser, desktop and process tools
// without asking (except process_start, which runs a command).
// The config goes in a private file: on the command line, other users on
// the machine could read the token from the process list.
func (s *Server) claudeArgs(threadID, _ string) ([]string, func(), error) {
	key, err := s.browserKey(threadID)
	if err != nil {
		return nil, nil, err
	}
	endpoint, token, revoke, err := s.mcp.Grant(mcp.Caller{ThreadID: threadID, Browser: key})
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
	names := append(browser.ToolNames(), process.ToolNames()...)
	if s.desktop != nil {
		names = append(names, desktop.ToolNames()...)
	}
	allowed := make([]string, 0, len(names))
	for _, name := range names {
		allowed = append(allowed, "mcp__"+mcpName+"__"+name)
	}
	args := []string{"--mcp-config", path, "--allowedTools", strings.Join(allowed, ",")}
	if a, err := s.store.AgentThread(threadID); err == nil && a.Scratch {
		args = append(args, "--append-system-prompt", s.scratchPrompt(a.Dir))
	}
	return args, release, nil
}

// clearMCPConfigs removes configs left by a daemon that didn't exit
// cleanly; their tokens died with it.
func clearMCPConfigs(dir string) {
	paths, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	for _, p := range paths {
		_ = os.Remove(p)
	}
}
