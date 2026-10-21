package plugin

import (
	"encoding/json"
	"fmt"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// Services plugins export for each other, by name. They're interfaces here,
// not the exporting plugin's types, so a plugin depends on what it uses and
// not on how another plugin is built.
const (
	ServiceAgent    = "agent"
	ServiceTerminal = "terminal"
	ServiceDesktop  = "desktop"
)

// AgentService is the agent (Claude Code) plugin's, for plugins that talk to
// a thread's claude or put things in its timeline.
type AgentService interface {
	// Notify tells a thread's claude about an event (a process's): wake
	// starts a turn now (resuming claude if it stopped); otherwise it waits
	// for the next prompt. text is shown in the timeline, prompt sent to claude.
	Notify(threadID, name, text, prompt string, wake bool)
	// Send sends a prompt, as the user would.
	Send(threadID, text string) error
	// MarkDone marks the thread done when its turn completes (afterTurn) or now.
	MarkDone(threadID string) (afterTurn bool, err error)
	// ShareFiles copies files into the thread's chat.
	ShareFiles(threadID, caption string, paths []string) ([]protocol.AgentAttachment, error)
	// Status reports whether the thread's claude runs, and its status.
	Status(threadID string) (running bool, status string)
	// Conversation is the thread's log, oldest first (up to limit events).
	Conversation(threadID string, limit int) ([]json.RawMessage, error)
	// AddAgent adds a coding agent that speaks the Agent Client Protocol:
	// threads of its kind run it, drawn by the agent view. The kind is the
	// caller's (h is the caller's host); remove stops its threads and
	// forgets it, for when the caller stops.
	AddAgent(h Host, a AgentDef) (remove func())
}

// AgentDef is a coding agent another plugin adds.
type AgentDef struct {
	// Kind is its threads' kind.
	Kind  string
	Title string
	// Icon is its logo, a data: URL.
	Icon string
	// Command runs it as an ACP agent (in the thread's directory).
	Command []string
}

// TerminalService is the terminal plugin's.
type TerminalService interface {
	// Type types input into a terminal thread's shell (starting it at
	// cols×rows if it isn't running), without the writer role.
	Type(threadID string, input []byte, cols, rows uint16) error
	// Scrollback is the shell's recent output.
	Scrollback(threadID string) []byte
}

// DesktopService is the desktop plugin's.
type DesktopService interface {
	// Usable: remote desktop is enabled at the device and works here.
	Usable() bool
}

// Lookup finds a service of type T exported under name.
func Lookup[T any](h Host, name string) (T, bool) {
	var zero T
	v, ok := h.Service(name)
	if !ok {
		return zero, false
	}
	t, ok := v.(T)
	return t, ok
}

// MustLookup is Lookup for a service a plugin Requires; its absence is a
// bug in the start order.
func MustLookup[T any](h Host, name string) T {
	t, ok := Lookup[T](h, name)
	if !ok {
		panic(fmt.Sprintf("plugin %s: service %q missing", h.ID(), name))
	}
	return t
}
