// Command linear is an everywhere plugin for Linear: link a project to a
// Linear project or team, and its threads get a Linear tab listing the
// issues, each one's page (status, comments, a comment box), and a button
// that hands an issue to the thread's agent. Claude gets tools to read
// them too (linear_issues, linear_issue) and, asking first, to comment and
// move them (linear_comment, linear_set_status). The sidebar lists the
// issues assigned to you that are in progress.
//
// It talks to Linear's API from the device with a personal API key
// (Linear → Settings → Security & access → Personal API keys), kept as an
// account setting so every device has it.
//
// Install it on a device from the registry (or Settings → Plugins):
//
//	everywhere plugin install linear
//
// or, from this folder, a build of your own:
//
//	go build -o linear . && everywhere plugin install .
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/conner-replogle/everywhere/daemon/sdk/plugin"
)

func main() {
	p := plugin.New()
	lin := &client{
		key: func() string {
			var k string
			p.Setting("api_key", &k)
			return k
		},
		http: &http.Client{Timeout: 30 * time.Second},
	}
	kv := p.KV()

	// A project's link lives in its KV scope, so it goes with the project.
	type thread struct {
		ID        string `json:"id"`
		ProjectID string `json:"projectId"`
		ParentID  string `json:"parentId"`
		Kind      string `json:"kind"`
	}
	var threadOf func(id string) (thread, error)
	threadOf = func(id string) (thread, error) {
		var t thread
		if id == "" {
			return t, errors.New("no thread")
		}
		if err := p.Thread(id, &t); err != nil {
			return t, err
		}
		if t.ParentID != "" { // a tab: the thread it's in
			return threadOf(t.ParentID)
		}
		return t, nil
	}
	linkOf := func(threadID string) (thread, *Link, error) {
		t, err := threadOf(threadID)
		if err != nil || t.ProjectID == "" {
			return t, nil, err
		}
		var l Link
		ok, err := kv.Get("project:"+t.ProjectID, "link", &l)
		if !ok || err != nil {
			return t, nil, err
		}
		return t, &l, nil
	}
	changed := func(issue string) { _ = p.Emit(map[string]string{"event": "linear.changed", "issue": issue}) }

	type threadArgs struct {
		ThreadID string `json:"threadId"`
	}

	p.Method("linear.status", func(ctx context.Context, _ plugin.Call) (any, error) {
		me, err := lin.viewer(ctx)
		if errors.Is(err, errNoKey) {
			return map[string]any{"configured": false}, nil
		}
		if err != nil {
			return map[string]any{"configured": true, "error": err.Error()}, nil
		}
		return map[string]any{"configured": true, "viewer": me}, nil
	})

	p.Method("linear.link.get", func(_ context.Context, c plugin.Call) (any, error) {
		var a threadArgs
		_ = c.Decode(&a)
		t, l, err := linkOf(a.ThreadID)
		if err != nil {
			return nil, err
		}
		return map[string]any{"projectId": t.ProjectID, "threadKind": t.Kind, "link": l}, nil
	})
	p.Method("linear.link.set", func(_ context.Context, c plugin.Call) (any, error) {
		var a struct {
			ThreadID string `json:"threadId"`
			Link     *Link  `json:"link"`
		}
		if err := c.Decode(&a); err != nil {
			return nil, err
		}
		t, err := threadOf(a.ThreadID)
		if err != nil {
			return nil, err
		}
		if t.ProjectID == "" {
			return nil, errors.New("this thread isn't in a project")
		}
		if a.Link == nil {
			return struct{}{}, kv.Delete("project:"+t.ProjectID, "link")
		}
		if a.Link.Type != "project" && a.Link.Type != "team" || a.Link.ID == "" {
			return nil, errors.New("link a Linear project or team")
		}
		return struct{}{}, kv.Set("project:"+t.ProjectID, "link", a.Link)
	})
	p.Method("linear.targets", func(ctx context.Context, _ plugin.Call) (any, error) {
		return lin.targets(ctx)
	})

	p.Method("linear.issues", func(ctx context.Context, c plugin.Call) (any, error) {
		var a struct {
			ThreadID string `json:"threadId"`
			IssueQuery
		}
		if err := c.Decode(&a); err != nil {
			return nil, err
		}
		_, l, err := linkOf(a.ThreadID)
		if err != nil {
			return nil, err
		}
		if l == nil {
			return nil, errors.New("this project isn't linked to Linear")
		}
		return lin.issues(ctx, *l, a.IssueQuery)
	})
	p.Method("linear.issue", func(ctx context.Context, c plugin.Call) (any, error) {
		var a struct {
			ID string `json:"id"`
		}
		if err := c.Decode(&a); err != nil {
			return nil, err
		}
		return lin.issue(ctx, a.ID)
	})
	p.Method("linear.setState", func(ctx context.Context, c plugin.Call) (any, error) {
		var a struct{ IssueID, StateID string }
		if err := c.Decode(&a); err != nil {
			return nil, err
		}
		if err := lin.setState(ctx, a.IssueID, a.StateID); err != nil {
			return nil, err
		}
		changed(a.IssueID)
		return struct{}{}, nil
	})
	p.Method("linear.assignMe", func(ctx context.Context, c plugin.Call) (any, error) {
		var a struct{ IssueID string }
		if err := c.Decode(&a); err != nil {
			return nil, err
		}
		if err := lin.assignToMe(ctx, a.IssueID); err != nil {
			return nil, err
		}
		changed(a.IssueID)
		return struct{}{}, nil
	})
	p.Method("linear.comment", func(ctx context.Context, c plugin.Call) (any, error) {
		var a struct{ IssueID, Body string }
		if err := c.Decode(&a); err != nil {
			return nil, err
		}
		if strings.TrimSpace(a.Body) == "" {
			return nil, errors.New("write a comment")
		}
		if err := lin.comment(ctx, a.IssueID, a.Body); err != nil {
			return nil, err
		}
		changed(a.IssueID)
		return struct{}{}, nil
	})

	// Hand an issue to the thread's agent, as a prompt from the user.
	p.Method("linear.work", func(ctx context.Context, c plugin.Call) (any, error) {
		var a struct{ ThreadID, ID string }
		if err := c.Decode(&a); err != nil {
			return nil, err
		}
		t, err := threadOf(a.ThreadID)
		if err != nil {
			return nil, err
		}
		if t.Kind == "terminal" {
			return nil, errors.New("open it from an agent thread to hand it to the agent")
		}
		d, err := lin.issue(ctx, a.ID)
		if err != nil {
			return nil, err
		}
		return struct{}{}, p.SendToAgent(t.ID, workPrompt(d))
	})

	// A thread's header: a Linear button, once its project is linked.
	p.Method("linear.header", func(_ context.Context, c plugin.Call) (any, error) {
		var a threadArgs
		_ = c.Decode(&a)
		if _, l, _ := linkOf(a.ThreadID); l == nil {
			return []any{}, nil
		}
		return []map[string]any{{"label": "Linear", "icon": "list", "openTab": "linear"}}, nil
	})

	// The sidebar: your issues in progress, across the workspace.
	sb := &sidebarCache{}
	p.Method("linear.sidebar", func(ctx context.Context, _ plugin.Call) (any, error) {
		var show bool
		if !p.Setting("sidebar", &show) || !show {
			return map[string]any{"title": "Linear", "rows": []any{}}, nil
		}
		return sb.get(ctx, lin)
	})
	go func() {
		for range time.Tick(3 * time.Minute) {
			var show bool
			if !p.Setting("sidebar", &show) || !show {
				continue
			}
			if sb.refresh(context.Background(), lin) {
				_ = p.Emit(map[string]string{"event": "linear.ui.changed"})
			}
		}
	}()
	p.OnSettings(func(map[string]json.RawMessage) {
		sb.clear()
		_ = p.Emit(map[string]string{"event": "linear.ui.changed"})
		changed("")
	})

	// Tools for the thread's agent.
	toolLink := func(threadID string) (Link, error) {
		_, l, err := linkOf(threadID)
		if err != nil {
			return Link{}, err
		}
		if l == nil {
			return Link{}, errors.New("this thread's project isn't linked to Linear: the user links it in the thread's Linear tab")
		}
		return *l, nil
	}
	p.Tool("issues", func(ctx context.Context, c plugin.ToolCall) (string, error) {
		var q IssueQuery
		if err := c.Decode(&q); err != nil {
			return "", err
		}
		l, err := toolLink(c.ThreadID)
		if err != nil {
			return "", err
		}
		if q.Limit == 0 {
			q.Limit = 50
		}
		issues, err := lin.issues(ctx, l, q)
		if err != nil {
			return "", err
		}
		if len(issues) == 0 {
			return "No issues match in " + l.Name + ".", nil
		}
		var b strings.Builder
		fmt.Fprintf(&b, "Issues in %s (%d):\n", l.Name, len(issues))
		for _, is := range issues {
			fmt.Fprintf(&b, "- %s [%s] %s", is.Identifier, is.State.Name, is.Title)
			if is.Priority > 0 {
				fmt.Fprintf(&b, " · %s", is.PriorityLabel)
			}
			if is.Assignee != nil {
				fmt.Fprintf(&b, " · %s", is.Assignee.DisplayName)
			}
			b.WriteString("\n")
		}
		return b.String(), nil
	})
	p.Tool("issue", func(ctx context.Context, c plugin.ToolCall) (string, error) {
		var a struct{ ID string }
		if err := c.Decode(&a); err != nil {
			return "", err
		}
		d, err := lin.issue(ctx, a.ID)
		if err != nil {
			return "", err
		}
		return issueText(d), nil
	})
	p.Tool("comment", func(ctx context.Context, c plugin.ToolCall) (string, error) {
		var a struct{ ID, Body string }
		if err := c.Decode(&a); err != nil {
			return "", err
		}
		d, err := lin.issue(ctx, a.ID)
		if err != nil {
			return "", err
		}
		if err := lin.comment(ctx, d.ID, a.Body); err != nil {
			return "", err
		}
		changed(d.ID)
		return "Commented on " + d.Identifier + ".", nil
	})
	p.Tool("set_status", func(ctx context.Context, c plugin.ToolCall) (string, error) {
		var a struct{ ID, Status string }
		if err := c.Decode(&a); err != nil {
			return "", err
		}
		d, err := lin.issue(ctx, a.ID)
		if err != nil {
			return "", err
		}
		i := slices.IndexFunc(d.States, func(s State) bool { return strings.EqualFold(s.Name, strings.TrimSpace(a.Status)) })
		if i < 0 {
			names := make([]string, len(d.States))
			for j, s := range d.States {
				names[j] = s.Name
			}
			return "", fmt.Errorf("%s's team has no status %q; it has: %s", d.Identifier, a.Status, strings.Join(names, ", "))
		}
		if err := lin.setState(ctx, d.ID, d.States[i].ID); err != nil {
			return "", err
		}
		changed(d.ID)
		return fmt.Sprintf("Moved %s to %s.", d.Identifier, d.States[i].Name), nil
	})

	if err := p.Run(); err != nil {
		log.Fatal(err)
	}
}

func workPrompt(d IssueDetail) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Work on Linear issue %s: %s\n%s\n", d.Identifier, d.Title, d.URL)
	if d.BranchName != "" {
		fmt.Fprintf(&b, "Its branch name is %s.\n", d.BranchName)
	}
	if desc := strings.TrimSpace(d.Description); desc != "" {
		b.WriteString("\n" + desc + "\n")
	}
	if n := len(d.Comments.Nodes); n > 0 {
		fmt.Fprintf(&b, "\nIt has %d comment(s); read them with the linear_issue tool.\n", n)
	}
	return b.String()
}

// issueText is an issue as the agent reads it.
func issueText(d IssueDetail) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s: %s\n%s\n\n", d.Identifier, d.Title, d.URL)
	fmt.Fprintf(&b, "Status: %s\n", d.State.Name)
	if d.Priority > 0 {
		fmt.Fprintf(&b, "Priority: %s\n", d.PriorityLabel)
	}
	if d.Assignee != nil {
		fmt.Fprintf(&b, "Assignee: %s\n", d.Assignee.Name)
	}
	if d.Project != nil {
		fmt.Fprintf(&b, "Project: %s\n", d.Project.Name)
	}
	if len(d.Labels.Nodes) > 0 {
		names := make([]string, len(d.Labels.Nodes))
		for i, l := range d.Labels.Nodes {
			names[i] = l.Name
		}
		fmt.Fprintf(&b, "Labels: %s\n", strings.Join(names, ", "))
	}
	if d.BranchName != "" {
		fmt.Fprintf(&b, "Branch: %s\n", d.BranchName)
	}
	if d.Parent != nil {
		fmt.Fprintf(&b, "Parent: %s %s\n", d.Parent.Identifier, d.Parent.Title)
	}
	if len(d.Children.Nodes) > 0 {
		b.WriteString("Sub-issues:\n")
		for _, c := range d.Children.Nodes {
			fmt.Fprintf(&b, "- %s [%s] %s\n", c.Identifier, c.State.Name, c.Title)
		}
	}
	desc := strings.TrimSpace(d.Description)
	if desc == "" {
		desc = "(no description)"
	}
	b.WriteString("\n" + desc + "\n")
	for _, c := range d.Comments.Nodes {
		who := "someone"
		if c.User != nil {
			who = c.User.Name
		}
		fmt.Fprintf(&b, "\n--- %s, %s\n%s\n", who, c.CreatedAt, strings.TrimSpace(c.Body))
	}
	return b.String()
}

// sidebarCache keeps the sidebar's issues for a minute: the app asks again
// whenever threads change.
type sidebarCache struct {
	mu   sync.Mutex
	at   time.Time
	data any
	key  string
}

func (s *sidebarCache) clear() {
	s.mu.Lock()
	s.at = time.Time{}
	s.mu.Unlock()
}

func (s *sidebarCache) get(ctx context.Context, lin *client) (any, error) {
	s.mu.Lock()
	fresh := time.Since(s.at) < time.Minute && s.data != nil
	data := s.data
	s.mu.Unlock()
	if fresh {
		return data, nil
	}
	s.refresh(ctx, lin)
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data, nil
}

// refresh reads the issues again; true if they changed.
func (s *sidebarCache) refresh(ctx context.Context, lin *client) bool {
	type action struct {
		Label string `json:"label"`
		Href  string `json:"href"`
	}
	type row struct {
		Label  string            `json:"label"`
		Detail string            `json:"detail,omitempty"`
		Badge  map[string]string `json:"badge,omitempty"`
		Icon   string            `json:"icon,omitempty"`
		Action action            `json:"action"`
	}
	rows := []row{}
	var r struct {
		Issues struct{ Nodes []Issue }
	}
	err := lin.do(ctx, `query {
		issues(first: 15, orderBy: updatedAt, filter: { assignee: { isMe: { eq: true } }, state: { type: { eq: "started" } } }) {
			nodes { `+issueFields+` }
		}
	}`, nil, &r)
	switch {
	case errors.Is(err, errNoKey):
		// Say nothing until it's set up.
	case err != nil:
		rows = append(rows, row{Label: "Couldn't reach Linear", Detail: err.Error(), Icon: "info",
			Action: action{Label: "Open Linear", Href: "https://linear.app"}})
	default:
		for _, is := range r.Issues.Nodes {
			rows = append(rows, row{
				Label:  is.Title,
				Detail: is.Identifier,
				Badge:  map[string]string{"text": is.State.Name, "tone": "live"},
				Icon:   "flag",
				Action: action{Label: "Open in Linear", Href: is.URL},
			})
		}
	}
	data := map[string]any{"title": "Linear · in progress", "rows": rows}
	b, _ := json.Marshal(data)
	s.mu.Lock()
	defer s.mu.Unlock()
	same := string(b) == s.key
	s.data, s.key, s.at = data, string(b), time.Now()
	return !same
}
