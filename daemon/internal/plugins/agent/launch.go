package agent

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
)

// claudeArgs gives a claude thread's process the daemon's MCP server, with
// a token of its own, lets it use the tools plugins marked safe without
// asking, and adds what plugins contribute (system prompt, directories,
// MCP servers).
// The config goes in a private file: on the command line, other users on
// the machine could read the token from the process list.
func (p *Plugin) claudeArgs(threadID, projectID string) ([]string, func(), error) {
	key, err := p.h.Threads().Owner(threadID)
	if err != nil {
		return nil, nil, err
	}
	launch := plugin.AgentLaunch{ThreadID: threadID, ProjectID: projectID}
	if a, err := p.h.Store().AgentThread(threadID); err == nil {
		launch.Dir, launch.Scratch = a.Dir, a.Scratch
	}
	contrib := p.h.AgentContributions(launch)

	endpoint, token, revoke, err := p.h.Tools().Grant(mcp.Caller{ThreadID: threadID, Browser: key})
	if err != nil {
		return nil, nil, err
	}
	servers := map[string]any{plugin.ToolServerName: map[string]any{
		"type":    "http",
		"url":     endpoint,
		"headers": map[string]string{"Authorization": "Bearer " + token},
	}}
	for name, s := range contrib.MCPServers {
		if name != plugin.ToolServerName {
			servers[name] = s
		}
	}
	cfg, err := json.Marshal(map[string]any{"mcpServers": servers})
	if err != nil {
		revoke()
		return nil, nil, err
	}
	if err := os.MkdirAll(p.mcpDir, 0o700); err != nil {
		revoke()
		return nil, nil, err
	}
	f, err := os.CreateTemp(p.mcpDir, threadID+"-*.json")
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
	allowed := slices.Compact(slices.Sorted(slices.Values(append(p.h.Tools().Allowed(), contrib.AllowedTools...))))
	args := []string{"--mcp-config", path, "--allowedTools", strings.Join(allowed, ",")}
	for _, d := range contrib.AddDirs {
		args = append(args, "--add-dir", d)
	}
	if len(contrib.SystemPrompt) > 0 {
		args = append(args, "--append-system-prompt", strings.Join(contrib.SystemPrompt, "\n\n"))
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

// ClaudeArgs is what a claude process for the thread is started with, for tests.
func (p *Plugin) ClaudeArgs(threadID, projectID string) ([]string, func(), error) {
	return p.claudeArgs(threadID, projectID)
}
