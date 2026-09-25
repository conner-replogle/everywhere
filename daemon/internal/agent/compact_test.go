package agent

import "testing"

func TestCompactNotice(t *testing.T) {
	for _, c := range []struct {
		trigger   string
		pre, post int
		want      string
	}{
		{"manual", 0, 0, "Conversation compacted"},
		{"auto", 182_400, 21_600, "Conversation compacted automatically · 182k → 22k tokens"},
		{"manual", 1_250_000, 900, "Conversation compacted · 1.2M → 900 tokens"},
	} {
		if got := compactNotice(c.trigger, c.pre, c.post); got != c.want {
			t.Errorf("compactNotice(%q, %d, %d) = %q, want %q", c.trigger, c.pre, c.post, got, c.want)
		}
	}
}

func TestContextFull(t *testing.T) {
	if !contextFull("prompt_too_long", "") || !contextFull("", "API Error: Prompt is too long") ||
		!contextFull("", "input exceeds the context window") || contextFull("", "rate limited") {
		t.Fatal("contextFull misclassified")
	}
}
