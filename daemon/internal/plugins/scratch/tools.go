package scratch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// startModes are the permission modes thread_start may give a new claude
// thread: an agent can't start one that asks for nothing.
var startModes = []string{"default", "acceptEdits", "plan", "auto"}

// tools let a thread's agent set up work elsewhere: find or make a project
// (cloning it if need be) and start a thread in it with a prompt.
func (p *Plugin) tools() []mcp.Tool {
	return []mcp.Tool{{
		Name:        "projects_list",
		Title:       "List projects",
		Description: "List the Everywhere projects on this device: id, name and folder. Scratch and the home folder are marked.",
		InputSchema: json.RawMessage(`{"type": "object", "properties": {}}`),
		Annotations: mcp.Annotations{ReadOnly: true},
		Call: func(context.Context, mcp.Caller, json.RawMessage) (*mcp.Result, error) {
			projects, err := p.h.Store().ListProjects()
			if err != nil {
				return nil, err
			}
			return mcp.JSON(projects)
		},
	}, {
		Name:  "project_create",
		Title: "Create a project",
		Description: "Make a folder an Everywhere project, so threads can work in it. " +
			"With url, clone that repository (https:// or git@, with this device's git credentials) into path first, which must be missing or empty; the call returns once the clone finishes. " +
			"Without url, path is an existing folder (it's created if missing). " +
			"Put new clones where the user keeps their projects (see projects_list) unless they said where. " +
			"Check projects_list first: a folder can only be one project.",
		InputSchema: json.RawMessage(`{"type": "object", "properties": {
  "path": {"type": "string", "description": "The project's folder: absolute, or starting with ~/."},
  "url": {"type": "string", "description": "A git repository to clone into path."},
  "name": {"type": "string", "description": "The project's name; defaults to the folder's name."}
}, "required": ["path"]}`),
		Call: func(ctx context.Context, _ mcp.Caller, args json.RawMessage) (*mcp.Result, error) {
			var a struct{ Path, URL, Name string }
			if err := json.Unmarshal(args, &a); err != nil {
				return nil, err
			}
			proj, err := p.createProject(ctx, a.Path, a.URL, a.Name)
			if err != nil {
				return nil, err
			}
			return mcp.JSON(proj)
		},
	}, {
		Name:  "thread_start",
		Title: "Start a thread",
		Description: "Start a new agent thread in a project, with a first prompt it starts working on right away. " +
			"It shows in the user's sidebar under the project; tell them it's there. " +
			"The new thread knows nothing of this conversation, so the prompt must stand on its own: the task, what the user asked for, and what you've learned that it needs. " +
			"Use it when the user asks for work to be done in a project, rather than doing it from here.",
		InputSchema: json.RawMessage(`{"type": "object", "properties": {
  "projectId": {"type": "string", "description": "The project's id, from projects_list or project_create."},
  "prompt": {"type": "string", "description": "The thread's first message."},
  "name": {"type": "string", "description": "A short name for the thread; by default it's named after the prompt."},
  "kind": {"type": "string", "description": "The agent: claude (the default) or another agent's thread kind, such as opencode."},
  "permissionMode": {"type": "string", "enum": ["default", "acceptEdits", "plan", "auto"], "description": "A claude thread's starting mode; by default, the project's usual (ask before edits and commands)."}
}, "required": ["projectId", "prompt"]}`),
		Call: func(_ context.Context, _ mcp.Caller, args json.RawMessage) (*mcp.Result, error) {
			var a struct{ ProjectID, Prompt, Name, Kind, PermissionMode string }
			if err := json.Unmarshal(args, &a); err != nil {
				return nil, err
			}
			t, err := p.startThread(a.ProjectID, a.Kind, a.Name, a.Prompt, a.PermissionMode)
			if err != nil {
				return nil, err
			}
			return mcp.JSON(t)
		},
	}}
}

// createProject makes path a project, cloning url into it first if given.
func (p *Plugin) createProject(ctx context.Context, path, url, name string) (protocol.Project, error) {
	if strings.TrimSpace(path) == "" {
		return protocol.Project{}, errors.New("path is required")
	}
	if strings.TrimSpace(url) != "" {
		clone, ok := plugin.Lookup[plugin.CloneService](p.h, plugin.ServiceClone)
		if !ok {
			return protocol.Project{}, errors.New("cloning isn't available on this device")
		}
		proj, done, err := clone.Clone(url, path, name)
		if err != nil {
			return proj, err
		}
		select {
		case err := <-done:
			if err != nil {
				return proj, fmt.Errorf("project %s was created, but the clone failed: %w", proj.ID, err)
			}
			return proj, nil
		case <-ctx.Done():
			return proj, fmt.Errorf("project %s was created and is still cloning", proj.ID)
		}
	}
	path, err := expandHome(path)
	if err != nil {
		return protocol.Project{}, err
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		return protocol.Project{}, err
	}
	proj, err := p.h.Store().CreateProject(path, name)
	if err == nil {
		p.h.Emit(protocol.RPCEvent{Event: protocol.EventProjectsChanged})
	}
	return proj, err
}

// startThread starts an agent thread in a project with its first prompt, as
// threads.create does.
func (p *Plugin) startThread(projectID, kind, name, prompt, mode string) (protocol.Thread, error) {
	if strings.TrimSpace(prompt) == "" {
		return protocol.Thread{}, errors.New("prompt is required")
	}
	if kind == "" {
		kind = protocol.ThreadClaude
	}
	k, ok := p.h.Kind(kind)
	if !ok || !k.Thread || (kind != protocol.ThreadClaude && k.View != "agent") {
		return protocol.Thread{}, fmt.Errorf("%q isn't an agent on this device", kind)
	}
	if mode != "" && (kind != protocol.ThreadClaude || !slices.Contains(startModes, mode)) {
		return protocol.Thread{}, fmt.Errorf("permission mode %q can't be set here", mode)
	}
	t, err := p.h.Store().CreateThread(projectID, name, kind)
	if err != nil {
		return t, err
	}
	p.h.Threads().Changed()
	if k.Created != nil {
		err = k.Created(t, plugin.CreateParams{PermissionMode: mode, Prompt: prompt})
	}
	return t, err
}

func expandHome(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, strings.TrimPrefix(path, "~"))
	}
	return filepath.Abs(path)
}
