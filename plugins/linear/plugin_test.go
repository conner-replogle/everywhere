package main

import (
	"strings"
	"testing"
)

func TestIssueText(t *testing.T) {
	var d IssueDetail
	d.Identifier, d.Title, d.URL = "ENG-1", "Fix the thing", "https://linear.app/x/issue/ENG-1"
	d.State = State{Name: "Todo"}
	d.Description = "It's broken."
	got := issueText(d)
	for _, want := range []string{"ENG-1: Fix the thing", "Status: Todo", "It's broken."} {
		if !strings.Contains(got, want) {
			t.Errorf("issueText lacks %q:\n%s", want, got)
		}
	}
	if p := workPrompt(d); !strings.HasPrefix(p, "Work on Linear issue ENG-1: Fix the thing") {
		t.Errorf("workPrompt: %s", p)
	}
}
