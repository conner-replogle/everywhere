package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const endpoint = "https://api.linear.app/graphql"

var errNoKey = errors.New("add a Linear API key in Settings → Plugins → Linear")

// client calls Linear's GraphQL API with a personal API key.
type client struct {
	key  func() string
	http *http.Client
}

func (c *client) do(ctx context.Context, query string, vars map[string]any, out any) error {
	key := strings.TrimSpace(c.key())
	if key == "" {
		return errNoKey
	}
	body, err := json.Marshal(map[string]any{"query": query, "variables": vars})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", key)
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("reaching Linear: %w", err)
	}
	defer res.Body.Close()
	var r struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Message    string `json:"message"`
			Extensions struct {
				UserPresentableMessage string `json:"userPresentableMessage"`
			} `json:"extensions"`
		} `json:"errors"`
	}
	if err := json.NewDecoder(res.Body).Decode(&r); err != nil {
		return fmt.Errorf("Linear answered %s", res.Status)
	}
	if len(r.Errors) > 0 {
		e := r.Errors[0]
		msg := e.Extensions.UserPresentableMessage
		if msg == "" {
			msg = e.Message
		}
		if res.StatusCode == http.StatusUnauthorized || strings.Contains(strings.ToLower(msg), "authentication") {
			return errors.New("Linear refused the API key: check it in Settings → Plugins → Linear")
		}
		return fmt.Errorf("Linear: %s", msg)
	}
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("Linear answered %s", res.Status)
	}
	return json.Unmarshal(r.Data, out)
}

// --- what we read --------------------------------------------------------------

type State struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Type     string  `json:"type"` // triage | backlog | unstarted | started | completed | canceled
	Color    string  `json:"color"`
	Position float64 `json:"position"`
}

type User struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	AvatarURL   string `json:"avatarUrl,omitempty"`
}

type Label struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

type Issue struct {
	ID            string  `json:"id"`
	Identifier    string  `json:"identifier"`
	Title         string  `json:"title"`
	URL           string  `json:"url"`
	Priority      int     `json:"priority"` // 0 none, 1 urgent, 2 high, 3 medium, 4 low
	PriorityLabel string  `json:"priorityLabel"`
	Estimate      float64 `json:"estimate,omitempty"`
	BranchName    string  `json:"branchName"`
	UpdatedAt     string  `json:"updatedAt"`
	CreatedAt     string  `json:"createdAt"`
	State         State   `json:"state"`
	Assignee      *User   `json:"assignee"`
	Team          struct {
		ID   string `json:"id"`
		Key  string `json:"key"`
		Name string `json:"name"`
	} `json:"team"`
	Project *struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"project"`
	Labels struct {
		Nodes []Label `json:"nodes"`
	} `json:"labels"`
}

type Comment struct {
	ID        string `json:"id"`
	Body      string `json:"body"`
	CreatedAt string `json:"createdAt"`
	User      *User  `json:"user"`
}

// IssueDetail is an issue with what its page shows.
type IssueDetail struct {
	Issue
	Description string `json:"description"`
	Creator     *User  `json:"creator"`
	Parent      *struct {
		Identifier string `json:"identifier"`
		Title      string `json:"title"`
	} `json:"parent"`
	Children struct {
		Nodes []struct {
			Identifier string `json:"identifier"`
			Title      string `json:"title"`
			State      State  `json:"state"`
		} `json:"nodes"`
	} `json:"children"`
	Comments struct {
		Nodes []Comment `json:"nodes"`
	} `json:"comments"`
	// States are the issue's team's workflow states, to move it between.
	States []State `json:"states"`
}

const issueFields = `
	id identifier title url priority priorityLabel estimate branchName updatedAt createdAt
	state { id name type color position }
	assignee { id name displayName avatarUrl }
	team { id key name }
	project { id name }
	labels { nodes { name color } }`

// Link is what an everywhere project shows of Linear: a Linear project, or
// all of a team's issues.
type Link struct {
	Type string `json:"type"` // project | team
	ID   string `json:"id"`
	Name string `json:"name"`
	URL  string `json:"url,omitempty"`
}

// Target is something a project can be linked to.
type Target = Link

func (c *client) viewer(ctx context.Context) (User, error) {
	var r struct{ Viewer User }
	err := c.do(ctx, `query { viewer { id name displayName avatarUrl } }`, nil, &r)
	return r.Viewer, err
}

// targets lists the teams and active projects one can link to.
func (c *client) targets(ctx context.Context) ([]Target, error) {
	var r struct {
		Teams struct {
			Nodes []struct{ ID, Key, Name string }
		}
		Projects struct {
			Nodes []struct {
				ID, Name, URL           string
				CompletedAt, CanceledAt *string
				Teams                   struct{ Nodes []struct{ Key string } }
			}
		}
	}
	err := c.do(ctx, `query {
		teams(first: 100) { nodes { id key name } }
		projects(first: 250, orderBy: updatedAt) {
			nodes { id name url completedAt canceledAt teams { nodes { key } } }
		}
	}`, nil, &r)
	if err != nil {
		return nil, err
	}
	out := []Target{}
	for _, p := range r.Projects.Nodes {
		if p.CompletedAt != nil || p.CanceledAt != nil {
			continue
		}
		keys := make([]string, 0, len(p.Teams.Nodes))
		for _, t := range p.Teams.Nodes {
			keys = append(keys, t.Key)
		}
		name := p.Name
		if len(keys) > 0 {
			name += " · " + strings.Join(keys, ", ")
		}
		out = append(out, Target{Type: "project", ID: p.ID, Name: name, URL: p.URL})
	}
	for _, t := range r.Teams.Nodes {
		out = append(out, Target{Type: "team", ID: t.ID, Name: t.Name + " (" + t.Key + ")"})
	}
	return out, nil
}

// IssueQuery picks a link's issues.
type IssueQuery struct {
	// Mine: only the viewer's.
	Mine bool `json:"mine,omitempty"`
	// Closed: done and canceled ones too (recent first).
	Closed bool `json:"closed,omitempty"`
	// Search matches title words or an identifier.
	Search string `json:"search,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}

func (c *client) issues(ctx context.Context, l Link, q IssueQuery) ([]Issue, error) {
	filter := map[string]any{}
	switch l.Type {
	case "project":
		filter["project"] = map[string]any{"id": map[string]any{"eq": l.ID}}
	case "team":
		filter["team"] = map[string]any{"id": map[string]any{"eq": l.ID}}
	default:
		return nil, errors.New("this project isn't linked to Linear")
	}
	if q.Mine {
		filter["assignee"] = map[string]any{"isMe": map[string]any{"eq": true}}
	}
	if !q.Closed {
		filter["state"] = map[string]any{"type": map[string]any{"nin": []string{"completed", "canceled"}}}
	}
	if s := strings.TrimSpace(q.Search); s != "" {
		or := []any{map[string]any{"title": map[string]any{"containsIgnoreCase": s}}}
		if team, num, ok := strings.Cut(s, "-"); ok {
			var n int
			if _, err := fmt.Sscanf(num, "%d", &n); err == nil {
				or = append(or, map[string]any{"and": []any{
					map[string]any{"team": map[string]any{"key": map[string]any{"eqIgnoreCase": team}}},
					map[string]any{"number": map[string]any{"eq": n}},
				}})
			}
		}
		filter["or"] = or
	}
	limit := q.Limit
	if limit <= 0 || limit > 250 {
		limit = 250
	}
	var r struct {
		Issues struct{ Nodes []Issue }
	}
	err := c.do(ctx, `query($filter: IssueFilter, $first: Int) {
		issues(filter: $filter, first: $first, orderBy: updatedAt) { nodes { `+issueFields+` } }
	}`, map[string]any{"filter": filter, "first": limit}, &r)
	if r.Issues.Nodes == nil {
		r.Issues.Nodes = []Issue{}
	}
	return r.Issues.Nodes, err
}

// issue gets one issue by its identifier (ENG-123) or id.
func (c *client) issue(ctx context.Context, id string) (IssueDetail, error) {
	var r struct {
		Issue *struct {
			IssueDetail
			Team struct {
				ID     string `json:"id"`
				Key    string `json:"key"`
				Name   string `json:"name"`
				States struct {
					Nodes []State `json:"nodes"`
				} `json:"states"`
			} `json:"team"`
		}
	}
	err := c.do(ctx, `query($id: String!) {
		issue(id: $id) {
			`+issueFields+`
			description
			creator { id name displayName }
			parent { identifier title }
			children(first: 50) { nodes { identifier title state { id name type color position } } }
			comments(first: 100, orderBy: createdAt) { nodes { id body createdAt user { id name displayName } } }
			team { id key name states(first: 50) { nodes { id name type color position } } }
		}
	}`, map[string]any{"id": strings.TrimSpace(id)}, &r)
	if err != nil {
		return IssueDetail{}, err
	}
	if r.Issue == nil {
		return IssueDetail{}, fmt.Errorf("no issue %s", id)
	}
	d := r.Issue.IssueDetail
	d.Team.ID, d.Team.Key, d.Team.Name = r.Issue.Team.ID, r.Issue.Team.Key, r.Issue.Team.Name
	d.States = r.Issue.Team.States.Nodes
	if d.States == nil {
		d.States = []State{}
	}
	return d, nil
}

func (c *client) setState(ctx context.Context, issueID, stateID string) error {
	var r struct {
		IssueUpdate struct{ Success bool }
	}
	return c.do(ctx, `mutation($id: String!, $state: String!) {
		issueUpdate(id: $id, input: { stateId: $state }) { success }
	}`, map[string]any{"id": issueID, "state": stateID}, &r)
}

func (c *client) assignToMe(ctx context.Context, issueID string) error {
	me, err := c.viewer(ctx)
	if err != nil {
		return err
	}
	var r struct {
		IssueUpdate struct{ Success bool }
	}
	return c.do(ctx, `mutation($id: String!, $me: String!) {
		issueUpdate(id: $id, input: { assigneeId: $me }) { success }
	}`, map[string]any{"id": issueID, "me": me.ID}, &r)
}

func (c *client) comment(ctx context.Context, issueID, body string) error {
	var r struct {
		CommentCreate struct{ Success bool }
	}
	return c.do(ctx, `mutation($id: String!, $body: String!) {
		commentCreate(input: { issueId: $id, body: $body }) { success }
	}`, map[string]any{"id": issueID, "body": body}, &r)
}
