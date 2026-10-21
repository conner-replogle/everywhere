package harness

import (
	"encoding/json"
	"testing"
)

// Agents' tool calls are named and shaped like Claude Code's, which the
// timeline draws.
func TestToolNames(t *testing.T) {
	old := "a"
	cases := []struct {
		title, kind, input string
		diff               *acpToolContent
		name, want         string
	}{
		{"bash", "execute", `{"command":"ls -la","cwd":"/x"}`, nil, "Bash", `{"command":"ls -la","cwd":"/x"}`},
		{"cat a.txt", "execute", `{}`, nil, "Bash", `{"command":"cat a.txt"}`},
		{"read", "read", `{"filePath":"/x/a.go","offset":3}`, nil, "Read", `{"file_path":"/x/a.go","offset":3}`},
		{"edit", "edit", `{"filePath":"/x/a.go","oldString":"a","newString":"b"}`, nil, "Edit", `{"file_path":"/x/a.go","new_string":"b","old_string":"a"}`},
		{"write", "edit", `{"filePath":"/x/b","content":"hi"}`, nil, "Write", `{"content":"hi","file_path":"/x/b"}`},
		{"Replace in a.go", "edit", `{}`, &acpToolContent{Type: "diff", Path: "/x/a.go", OldText: &old, NewText: "b"}, "Edit", `{"file_path":"/x/a.go","new_string":"b","old_string":"a"}`},
		{"grep", "search", `{"pattern":"foo"}`, nil, "Grep", `{"pattern":"foo"}`},
		{"todowrite", "other", `{"todos":[{"content":"x","status":"pending","activeForm":"x"}]}`, nil, "TodoWrite", `{"todos":[{"activeForm":"x","content":"x","status":"pending"}]}`},
		{"mcp_tool", "other", `{"someArg":1}`, nil, "mcp_tool", `{"some_arg":1}`},
	}
	for _, c := range cases {
		tc := &toolCall{title: c.title, kind: c.kind, diff: c.diff}
		_ = json.Unmarshal([]byte(c.input), &tc.input)
		name, input := tc.named()
		if name != c.name || string(input) != c.want {
			t.Errorf("%s/%s: got %s %s, want %s %s", c.title, c.kind, name, input, c.name, c.want)
		}
	}
}
