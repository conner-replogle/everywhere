// Package harness connects coding agents other than Claude Code to the
// agent engine (package agent), which runs every agent's threads alike: the
// event log, the live state, permissions, attachments, worktrees and the
// agent:<thread> channel the app's agent view draws. A harness is what's
// specific to one agent; claude's is package claude, and Conn here speaks
// the Agent Client Protocol (ACP), which OpenCode, Gemini CLI and others
// implement, translating it into claude's stream so the engine needn't
// know the difference.
//
// Any ACP agent is a few lines in Agents, or an installed plugin's
// "agents" in plugin.json (Add).
package harness

import (
	"encoding/json"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"unicode"

	_ "embed"
)

// Agent is a kind of agent the daemon can run threads of.
type Agent struct {
	// Kind is its threads' kind (protocol.Thread.Kind).
	Kind  string
	Title string
	// Icon is its logo as a data: URL, drawn in the text color.
	Icon string
	// Command runs it as an ACP agent, in the thread's directory.
	Command []string
	// Install says how to get it, when it's missing.
	Install string
}

//go:embed icons/opencode.svg
var opencodeIcon string

// Agents are the agents the daemon knows how to run.
var Agents = []Agent{
	{
		Kind: "opencode", Title: "OpenCode", Icon: svgURL(opencodeIcon),
		Command: []string{"opencode", "acp"},
		Install: "Install OpenCode (opencode.ai) and sign it in with `opencode auth login`.",
	},
}

// Available are the agents installed here.
func Available() []Agent {
	var out []Agent
	for _, a := range Agents {
		if _, err := exec.LookPath(a.Command[0]); err == nil {
			out = append(out, a)
		}
	}
	return out
}

var (
	addedMu sync.Mutex
	added   = map[string]addedAgent{}
	adds    int
)

type addedAgent struct {
	Agent
	n int
}

// Add adds an agent a plugin brings (its Command resolved already), until
// the returned function removes it. It replaces one of the same kind.
func Add(a Agent) (remove func()) {
	addedMu.Lock()
	adds++
	n := adds
	added[a.Kind] = addedAgent{a, n}
	addedMu.Unlock()
	return func() {
		addedMu.Lock()
		if added[a.Kind].n == n {
			delete(added, a.Kind)
		}
		addedMu.Unlock()
	}
}

// ByKind finds an agent by its threads' kind: a built-in one or one added.
func ByKind(kind string) (Agent, bool) {
	for _, a := range Agents {
		if a.Kind == kind {
			return a, true
		}
	}
	addedMu.Lock()
	defer addedMu.Unlock()
	a, ok := added[kind]
	return a.Agent, ok
}

func svgURL(svg string) string {
	return "data:image/svg+xml;utf8," + strings.NewReplacer("#", "%23", "\n", " ", `"`, "'").Replace(strings.TrimSpace(svg))
}

// --- tool calls ---------------------------------------------------------------

// The timeline draws tools by Claude Code's names and inputs (Bash
// {command}, Edit {file_path, old_string, new_string}…), which serve as the
// common vocabulary: an agent's tool calls are named and shaped like them
// where they're the same thing, and kept as they are otherwise.

// toolCall is what's known of a call so far; updates fill it in.
type toolCall struct {
	id       string
	title    string
	kind     string // read | edit | delete | move | search | execute | think | fetch | other
	input    map[string]any
	location string
	diff     *acpToolContent
	emitted  bool
	output   strings.Builder
}

func (t *toolCall) update(u acpUpdate) {
	if u.Title != nil && *u.Title != "" && (t.title == "" || u.Status != "completed") {
		t.title = *u.Title
	}
	if u.Kind != "" {
		t.kind = u.Kind
	}
	if len(u.RawInput) > 0 && string(u.RawInput) != "null" {
		var in map[string]any
		if json.Unmarshal(u.RawInput, &in) == nil && len(in) > 0 {
			t.input = in
		}
	}
	if len(u.Locations) > 0 && u.Locations[0].Path != "" {
		t.location = u.Locations[0].Path
	}
}

// ready: the call says enough to be drawn. Agents announce a call before
// its input is complete (OpenCode's bash has its cwd, not yet its command),
// so it's drawn once it runs, or when it asks for permission.
func (t *toolCall) ready(status string) bool {
	return status == "in_progress" || status == "completed" || status == "failed"
}

// named is the call in the common vocabulary: a name and an input.
func (t *toolCall) named() (string, json.RawMessage) {
	in := snakeKeys(t.input)
	if in == nil {
		in = map[string]any{}
	}
	if _, ok := in["file_path"]; !ok && t.location != "" {
		in["file_path"] = t.location
	}
	name := toolName(strings.ToLower(t.title), t.kind, in)
	switch name {
	case "Bash":
		if _, ok := in["command"]; !ok {
			in["command"] = t.title
		}
	case "Edit":
		if t.diff != nil {
			in["file_path"] = t.diff.Path
			in["old_string"] = deref(t.diff.OldText)
			in["new_string"] = t.diff.NewText
		}
	case "Write":
		if t.diff != nil && in["content"] == nil {
			in["file_path"] = t.diff.Path
			in["content"] = t.diff.NewText
		}
	}
	if name == t.title && name == "" {
		name = "tool"
	}
	raw, _ := json.Marshal(in)
	return name, raw
}

// toolName maps a call to the common vocabulary by its title (often the
// agent's own tool name) and kind.
func toolName(title, kind string, in map[string]any) string {
	switch title {
	case "bash", "shell", "run_shell_command", "execute":
		return "Bash"
	case "read", "read_file":
		return "Read"
	case "write", "write_file":
		return "Write"
	case "edit", "replace":
		return "Edit"
	case "multiedit":
		return "MultiEdit"
	case "grep", "search_file_content":
		return "Grep"
	case "glob", "list", "ls", "list_directory":
		return "Glob"
	case "webfetch", "web_fetch", "fetch":
		return "WebFetch"
	case "websearch", "web_search", "google_web_search":
		return "WebSearch"
	case "todowrite", "todo_write":
		return "TodoWrite"
	case "task":
		return "Task"
	}
	switch kind {
	case "execute":
		return "Bash"
	case "read":
		return "Read"
	case "edit":
		if _, ok := in["old_string"]; ok {
			return "Edit"
		}
		if _, ok := in["content"]; ok {
			return "Write"
		}
		return "Edit"
	case "search":
		return "Grep"
	case "fetch":
		return "WebFetch"
	}
	if title != "" {
		return title
	}
	return "tool"
}

var camel = regexp.MustCompile(`([a-z0-9])([A-Z])`)

// snakeKeys renames top-level camelCase keys (filePath) to snake_case
// (file_path). Nested values keep theirs: a todo list's are already the
// common ones (activeForm).
func snakeKeys(in map[string]any) map[string]any {
	if in == nil {
		return nil
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[snake(k)] = v
	}
	return out
}

func snake(k string) string {
	if !strings.ContainsFunc(k, unicode.IsUpper) {
		return k
	}
	return strings.ToLower(camel.ReplaceAllString(k, "${1}_${2}"))
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
