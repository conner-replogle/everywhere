package plugin

import "github.com/conner-replogle/everywhere/daemon/internal/protocol"

// Kind is a thread or tab kind as manifests report it.
type Kind = protocol.PluginKind

// CreateParams are what threads.create and tabs.create pass on to a kind.
type CreateParams struct {
	// PermissionMode is a claude thread's starting mode.
	PermissionMode string
	// Prompt is a claude thread's first prompt.
	Prompt string
	// Input is typed into a terminal tab's new shell without running it.
	Input string
}

// DeleteParams are what threads.delete passes on.
type DeleteParams struct {
	KeepWorktree bool `json:"keepWorktree,omitempty"`
	// RemoveScratch: delete a Scratch thread's folder too.
	RemoveScratch bool `json:"removeScratch,omitempty"`
}

// KindHandler is a thread or tab kind's behavior. Every hook is optional.
type KindHandler struct {
	Kind
	// Created runs after the thread or tab is stored.
	Created func(t protocol.Thread, p CreateParams) error
	// Status reports whether it's running and, for an agent, its status.
	Status func(t protocol.Thread) (running bool, agentStatus string)
	// Stop stops it when its thread is archived (history stays).
	Stop func(t protocol.Thread)
	// Delete is called before it's deleted from the store, with the
	// returned function (if any) called after: what needs the stored
	// record (an agent's worktree) is read before it goes.
	Delete func(t protocol.Thread, p DeleteParams) func()
}

// ThreadEvent is a thread (or tab) on the bus.
type ThreadEvent struct {
	Thread protocol.Thread `json:"thread"`
	// Tabs are its tabs, for a thread.
	Tabs []protocol.Thread `json:"tabs,omitempty"`
	// Delete is what threads.delete was asked (ThreadDeleted).
	Delete DeleteParams `json:"delete"`
	// Fail reports an error to the caller; the operation itself stands.
	Fail func(error) `json:"-"`
}

// Bus topics the core publishes.
var (
	// ThreadArchived: a thread and its tabs were archived (after their kinds stopped).
	ThreadArchived = Topic[ThreadEvent]{"thread.archived"}
	// ThreadDeleting: a thread or tab is about to be deleted.
	ThreadDeleting = Topic[ThreadEvent]{"thread.deleting"}
	// ThreadDeleted: a thread (with Tabs) or a tab was deleted.
	ThreadDeleted = Topic[ThreadEvent]{"thread.deleted"}
	// ProjectDeleted: a project was deleted, after its threads.
	ProjectDeleted = Topic[string]{"project.deleted"}
	// DaemonStopping: the daemon is shutting down.
	DaemonStopping = Topic[struct{}]{"daemon.stopping"}
	// DaemonUpdating: the daemon is about to restart into a new version.
	DaemonUpdating = Topic[struct{}]{"daemon.updating"}
	// ClientRevoked: a browser session was signed out (its hub connection id).
	ClientRevoked = Topic[string]{"client.revoked"}
)
