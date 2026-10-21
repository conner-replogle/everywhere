// Package protocol mirrors packages/protocol/src/index.ts. Keep them in sync.
package protocol

import "encoding/json"

// ---------------------------------------------------------------------------
// Hub WebSocket
// ---------------------------------------------------------------------------

const (
	HubPing = "ping"
	HubPong = "pong"
)

type IceCandidate struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *uint16 `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

// SignalData is an offer/answer ({type, sdp}), a trickled ICE candidate
// ({type: "candidate", candidate}) or {type: "bye"}.
type SignalData struct {
	Type      string        `json:"type"`
	SDP       string        `json:"sdp,omitempty"`
	Candidate *IceCandidate `json:"candidate,omitempty"`
}

// HubToDaemon is a relayed signal from a browser, an error,
// "client.revoked" (a browser connection's session was signed out), or
// "rpc" (a request from an agent using the account's MCP endpoint).
type HubToDaemon struct {
	T       string     `json:"t"`
	ConnID  string     `json:"connId,omitempty"`
	From    string     `json:"from,omitempty"`
	SID     string     `json:"sid,omitempty"`
	Data    SignalData `json:"data"`
	Code    string     `json:"code,omitempty"`
	Message string     `json:"message,omitempty"`
	// rpc
	ID     string          `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
}

type Hello struct {
	T       string `json:"t"` // "hello"
	Version string `json:"version"`
	// HubFeatures lists what the daemon supports over the hub socket.
	Features []string `json:"features,omitempty"`
}

// HubFeatureRPC: the daemon answers "rpc" requests from the hub.
const HubFeatureRPC = "rpc"

// HubFeatureClaudeToken: the daemon takes the account's Claude token
// (agent.setToken), which the hub sends when it connects.
const HubFeatureClaudeToken = "claudeToken"

// HubRPCResult answers a hub "rpc" request (T "rpc.result").
type HubRPCResult struct {
	T      string    `json:"t"`
	ID     string    `json:"id"`
	Result any       `json:"result,omitempty"`
	Error  *RPCError `json:"error,omitempty"`
}

// HubNotify tells the hub a claude thread needs the user or finished its
// turn, for a push notification. ThreadID is the thread or tab it happened
// in, ParentID a tab's thread. Only names travel, never content.
type HubNotify struct {
	T        string `json:"t"` // "notify"
	ThreadID string `json:"threadId"`
	ParentID string `json:"parentId,omitempty"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`           // permission | question | plan | done | error | signedOut
	Tool     string `json:"tool,omitempty"` // for permission
}

type SignalOut struct {
	T    string     `json:"t"` // "signal"
	To   string     `json:"to"`
	SID  string     `json:"sid"`
	Data SignalData `json:"data"`
}

// ---------------------------------------------------------------------------
// Data channels
// ---------------------------------------------------------------------------

const (
	ControlChannel      = "control"
	TermChannelPrefix   = "term:"
	AgentChannelPrefix  = "agent:"
	UploadChannelPrefix = "upload:"
	FileChannelPrefix   = "file:"
	ProcChannelPrefix   = "proc:" // a process's output; the term channel's protocol
)

type DeviceInfo struct {
	Hostname string `json:"hostname"`
	Home     string `json:"home"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
	Version  string `json:"version"`
	// Plugins lists the plugins running on the device.
	Plugins []PluginInfo `json:"plugins,omitempty"`
	// Features lists what this daemon supports beyond V1, so the web app can
	// adapt to older daemons.
	Features []string `json:"features"`
}

const (
	FeatureClaude       = "claude"       // claude threads and the agent channel
	FeatureUpdate       = "update"       // device.checkUpdate and device.update
	FeatureWorktrees    = "worktrees"    // claude threads in their own worktree; git.info
	FeatureAttachments  = "attachments"  // upload channels and send attachments
	FeatureHistory      = "history"      // agent attach limit and history paging
	FeatureArchive      = "archive"      // threads.archive and Thread.archivedAt
	FeatureTabs         = "tabs"         // tabs.*, fs.list, threads.workdir and file channels
	FeatureDesktop      = "desktop"      // desktop.info, desktop.start and desktop.stop
	FeatureRewind       = "rewind"       // the agent channel's rewind request
	FeatureIcons        = "icons"        // projects.icon
	FeatureClone        = "clone"        // projects.clone, clones.list and clones.changed
	FeatureGitStatus    = "gitStatus"    // git.status, git.fetch, git.pull, git.updateDefault and git.changed
	FeatureClaudeUpdate = "claudeUpdate" // agent.claudeVersion and agent.updateClaude
	FeatureMkdir        = "mkdir"        // fs.mkdir
	FeatureProcesses    = "processes"    // processes.*, the proc channel and the processes tab
	// FeatureScratch: the Scratch project (Project.IsScratch), threads in
	// their own scratch folder (Thread.ScratchDir), threads.promote,
	// threads.continueIn, threads.search, scratch.usage, threads.delete's
	// removeScratch, tabs.create's input and threads.create's prompt.
	FeatureScratch    = "scratch"
	FeatureClaudeAuth = "claudeAuth"  // agent.auth, agent.login*, claude.auth and kind signedOut
	FeatureDone       = "done"        // Thread.doneAt, threads.done and the thread_done tool
	FeatureToken      = "claudeToken" // agent.setToken and ClaudeAuth.token
)

// DesktopInfo is the result of desktop.info.
type DesktopInfo struct {
	// Enabled is whether the device owner turned remote desktop on
	// (`everywhere desktop enable`, run on the device).
	Enabled bool `json:"enabled"`
	// Available is whether a session can start now: the worker is installed
	// and a Hyprland session is running. Reason says why not.
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	// Viewer names who is connected, if anyone.
	Viewer string `json:"viewer,omitempty"`
}

// DesktopCandidateEvent carries one of a desktop session's ICE candidates to
// the browser on the control channel (trickle ICE; the browser sends its own
// with desktop.candidate).
type DesktopCandidateEvent struct {
	Event     string       `json:"event"` // EventDesktopCandidate
	ID        string       `json:"id"`
	Candidate IceCandidate `json:"candidate"`
}

const EventDesktopCandidate = "desktop.candidate"

// DesktopSource is what desktop.start captures: a monitor by name, or a
// window by id (Hyprland's stableId). Class and title find a tab's window
// again after its app restarted. Empty: the focused monitor. Desktop "claude"
// is Claude's own desktop, beside the user's; empty is the user's.
type DesktopSource struct {
	Desktop string `json:"desktop,omitempty"`
	Output  string `json:"output,omitempty"`
	Window  string `json:"window,omitempty"`
	Class   string `json:"class,omitempty"`
	Title   string `json:"title,omitempty"`
}

// DesktopStarted is the result of desktop.start {sdp, mode, viewer}: the
// session id (for desktop.stop) and the SDP answer for the desktop's own
// PeerConnection.
type DesktopStarted struct {
	ID  string `json:"id"`
	SDP string `json:"sdp"`
}

// UpdateInfo is the result of device.checkUpdate.
type UpdateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Available bool   `json:"available"`
	// Reason says why this daemon can't update itself (e.g. a dev build).
	Reason string `json:"reason,omitempty"`
}

// ClaudeVersion is the result of agent.claudeVersion: the device's Claude
// Code and the newest release.
type ClaudeVersion struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Available bool   `json:"available"`
	Path      string `json:"path"` // the claude executable
	// CanUpdate: agent.updateClaude runs Command, the update of the installer
	// that evidently owns this install. Otherwise it's updated the way it
	// was installed.
	CanUpdate bool   `json:"canUpdate"`
	Command   string `json:"command,omitempty"`
}

// ClaudeAuth is the result of agent.auth: whether the device's Claude Code
// is signed in.
type ClaudeAuth struct {
	SignedIn bool `json:"signedIn"`
	// Method is claude.ai, console, an API key's source, or none.
	Method       string `json:"method"`
	Email        string `json:"email,omitempty"`
	Org          string `json:"org,omitempty"`
	Subscription string `json:"subscription,omitempty"`
	// Problem is what claude said when a request was refused for its
	// credentials ("Not logged in · Please run /login"), until a sign-in or a
	// turn that works. SignedIn is false while it's set.
	Problem string `json:"problem,omitempty"`
	// SigningIn: an agent.login is waiting for its code.
	SigningIn bool `json:"signingIn,omitempty"`
	// Token (claudeToken): claude uses the account's Claude token (set in
	// Settings, sent by the hub with agent.setToken), not its own sign-in.
	Token bool `json:"token,omitempty"`
}

// ClaudeLogin is the result of agent.login: the sign-in page, which ends on
// a code to pass to agent.loginCode. Empty if claude signed in without one.
type ClaudeLogin struct {
	URL string `json:"url,omitempty"`
}

// EventClaudeAuth: the device's Claude Code was signed out or in.
const EventClaudeAuth = "claude.auth"

// ClaudeUpdateResult is the result of agent.updateClaude.
type ClaudeUpdateResult struct {
	Version string `json:"version"`
}

// UpdateResult is the result of device.update, sent just before the daemon
// restarts into the new version.
type UpdateResult struct {
	Version string `json:"version"`
}

type Project struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Path   string `json:"path"`
	IsHome bool   `json:"isHome"`
	// IsScratch marks Scratch, Everywhere's own project for work outside
	// any project; each of its threads works in a folder of its own.
	IsScratch bool  `json:"isScratch,omitempty"`
	CreatedAt int64 `json:"createdAt"`
}

const (
	ThreadTerminal = "terminal"
	ThreadClaude   = "claude"
	// Tabs only.
	ThreadBrowser   = "browser"
	ThreadFiles     = "files"
	ThreadDesktop   = "desktop" // a remote desktop view of one monitor or window
	ThreadProcesses = "processes"
)

// Thread is a thread, or a tab inside one (ParentID set).
type Thread struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	// ParentID is the thread a tab belongs to; "" for a thread.
	ParentID     string `json:"parentId,omitempty"`
	Kind         string `json:"kind"` // terminal | claude, and for tabs also browser | files
	Name         string `json:"name"`
	CreatedAt    int64  `json:"createdAt"`
	LastOpenedAt *int64 `json:"lastOpenedAt"`
	// Running reports a live shell (terminal) or claude process (claude).
	Running bool `json:"running"`
	// AgentStatus is set for claude threads; see AgentState.Status.
	AgentStatus string `json:"agentStatus,omitempty"`
	// Worktree is the git worktree a claude thread runs in, once created.
	Worktree string `json:"worktree,omitempty"`
	// ArchivedAt is set while the thread is archived: hidden from the
	// thread list, with its shell or claude stopped.
	ArchivedAt *int64 `json:"archivedAt,omitempty"`
	// TabState is a tab's UI state, as its view saved it.
	TabState string `json:"tabState,omitempty"`
	// Processes is how many of a thread's processes are running.
	Processes int `json:"processes,omitempty"`
	// ScratchDir is a Scratch thread's own folder, where it works.
	ScratchDir string `json:"scratchDir,omitempty"`
	// DoneAt is when the thread's agent said its work was done (thread_done),
	// until someone works in it again.
	DoneAt *int64 `json:"doneAt,omitempty"`
}

// ScratchUsage is the result of scratch.usage: how much the Scratch
// folders hold, in all and per thread folder.
type ScratchUsage struct {
	Root    string                 `json:"root"`
	Files   int                    `json:"files"`
	Bytes   int64                  `json:"bytes"`
	Folders map[string]ScratchSize `json:"folders"` // by folder path
	// Truncated: there were too many files to count them all.
	Truncated bool `json:"truncated,omitempty"`
}

type ScratchSize struct {
	Files int   `json:"files"`
	Bytes int64 `json:"bytes"`
}

// Workdir is where a thread works (threads.workdir): its worktree, the
// worktree of the thread it's a tab of, or the project directory.
type Workdir struct {
	Path     string `json:"path"`
	Worktree bool   `json:"worktree"`
}

// FsEntry is one entry of an fs.list listing.
type FsEntry struct {
	Name    string `json:"name"`
	Dir     bool   `json:"dir"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"` // unix ms
}

type FsListing struct {
	Path    string    `json:"path"`
	Parent  *string   `json:"parent"`
	Entries []FsEntry `json:"entries"`
}

// File channel file:<id>, one per read: the client sends FileRead as text;
// the daemon answers FileStart, the file as binary chunks, then {"t":"end"},
// or FileError at any point.
type (
	FileRead struct {
		T    string `json:"t"` // "read"
		Path string `json:"path"`
	}
	FileStart struct {
		T       string `json:"t"` // "start"
		Path    string `json:"path"`
		Size    int64  `json:"size"`
		ModTime int64  `json:"modTime"`
	}
	FileError struct {
		T       string `json:"t"` // "error"
		Message string `json:"message"`
	}
)

type DirListing struct {
	Path   string   `json:"path"`
	Parent *string  `json:"parent"`
	Dirs   []string `json:"dirs"`
}

type CandidateInfo struct {
	Type     string `json:"type"`
	Protocol string `json:"protocol"`
	Address  string `json:"address"`
	Port     uint16 `json:"port"`
}

type CandidatePair struct {
	Local  CandidateInfo `json:"local"`
	Remote CandidateInfo `json:"remote"`
}

type NetInterface struct {
	Name      string   `json:"name"`
	Addresses []string `json:"addresses"`
}

// PeerDebug is the daemon's view of one browser peer connection.
type PeerDebug struct {
	SID                string          `json:"sid"`
	ConnectionState    string          `json:"connectionState"`
	ICEConnectionState string          `json:"iceConnectionState"`
	SelectedPair       *CandidatePair  `json:"selectedPair"`
	LocalCandidates    []CandidateInfo `json:"localCandidates"`
	RemoteCandidates   []CandidateInfo `json:"remoteCandidates"`
	Interfaces         []NetInterface  `json:"interfaces"`
	OpenTerminals      int             `json:"openTerminals"`
	ConnectedForMs     int64           `json:"connectedForMs"`
}

type RPCRequest struct {
	ID     int64           `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type RPCError struct {
	Message string `json:"message"`
}

type RPCResponse struct {
	ID     int64     `json:"id"`
	Result any       `json:"result,omitempty"`
	Error  *RPCError `json:"error,omitempty"`
}

type RPCEvent struct {
	Event string `json:"event"`
}

const (
	EventProjectsChanged = "projects.changed"
	EventClonesChanged   = "clones.changed"
	EventGitChanged      = "git.changed" // a fetch or git action finished; statuses may differ
	EventThreadsChanged  = "threads.changed"
)

// ProcessesChanged is sent when a thread's processes start, stop or make
// progress, at most a few times a second per thread.
type ProcessesChanged struct {
	Event    string `json:"event"` // EventProcessesChanged
	ThreadID string `json:"threadId"`
}

const EventProcessesChanged = "processes.changed"

// TelemetryChanged is sent when a project's telemetry got new data: by
// experiment, the metrics that did (empty if only events did). Charts
// showing them ask again.
type TelemetryChanged struct {
	Event       string              `json:"event"` // EventTelemetryChanged
	Home        string              `json:"home"`
	Experiments map[string][]string `json:"experiments"`
}

const EventTelemetryChanged = "telemetry.changed"

// TermClientMsg is attach | resize | takeover.
type TermClientMsg struct {
	T    string `json:"t"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

type TermWriter struct {
	T   string `json:"t"` // "writer"
	You bool   `json:"you"`
}

type TermExited struct {
	T    string `json:"t"` // "exited"
	Code int    `json:"code"`
}

type TermError struct {
	T       string `json:"t"` // "error"
	Message string `json:"message"`
}

// ---------------------------------------------------------------------------
// Agent channel agent:<threadId>: JSON text frames in both directions.
// ---------------------------------------------------------------------------

// AgentClientMsg is a frame from the browser, discriminated by T:
//   - attach {afterSeq, limit?}: must come first; replays the newest limit
//     events after afterSeq
//   - history {beforeSeq, limit?}: the page of events before beforeSeq, as
//     a history frame to this client only
//   - send {text, attachments?}: a prompt; starts or resumes claude as needed.
//     Attachments are ids from finished uploads.
//   - interrupt
//   - respond {requestId, decision, message?, answers?}
//   - setMode {mode}, setModel {model}
//   - setWorkspace {workspace, baseBranch}: before the first prompt only
//   - setEffort {effort}: low | medium | high | xhigh | max, or "" for the
//     model's default
//   - setThinking {thinking}
//   - rewind {id, files}: rolls the conversation back to before the prompt
//     with event id id and, with files, claude's file edits since
type AgentClientMsg struct {
	T         string            `json:"t"`
	AfterSeq  int64             `json:"afterSeq,omitempty"`
	BeforeSeq int64             `json:"beforeSeq,omitempty"`
	Limit     int               `json:"limit,omitempty"` // attach and history: page size
	Text      string            `json:"text,omitempty"`
	RequestID string            `json:"requestId,omitempty"`
	Decision  string            `json:"decision,omitempty"` // allow | allowSession | deny
	Message   string            `json:"message,omitempty"`  // deny: feedback for claude
	Answers   map[string]string `json:"answers,omitempty"`  // question requests: question -> answer
	Mode      string            `json:"mode,omitempty"`
	Model     string            `json:"model,omitempty"`
	// Workspace is local | worktree.
	Workspace   string   `json:"workspace,omitempty"`
	BaseBranch  string   `json:"baseBranch,omitempty"`
	Attachments []string `json:"attachments,omitempty"`
	Effort      string   `json:"effort,omitempty"`
	Thinking    *bool    `json:"thinking,omitempty"`
	ID          string   `json:"id,omitempty"`    // rewind: the prompt's event id
	Files       bool     `json:"files,omitempty"` // rewind: restore files too
}

// Frames from the daemon, discriminated by T.
type (
	// AgentEventMsg carries one persisted event (T "event").
	AgentEventMsg struct {
		T     string          `json:"t"`
		Seq   int64           `json:"seq"`
		At    int64           `json:"at"`
		Event json.RawMessage `json:"event"`
	}
	// AgentHistoryMsg answers history (T "history"): events oldest first,
	// and whether there are more before them.
	AgentHistoryMsg struct {
		T      string             `json:"t"`
		Events []AgentLoggedEvent `json:"events"`
		More   bool               `json:"more"`
	}
	AgentLoggedEvent struct {
		Seq   int64           `json:"seq"`
		At    int64           `json:"at"`
		Event json.RawMessage `json:"event"`
	}
	// AgentSyncedMsg ends the replay that follows attach (T "synced").
	// Truncated means older events were left out.
	AgentSyncedMsg struct {
		T         string `json:"t"`
		Truncated bool   `json:"truncated"`
	}
	// AgentStateMsg is the full live state (T "state"), sent after the
	// replay and whenever it changes.
	AgentStateMsg struct {
		T     string     `json:"t"`
		State AgentState `json:"state"`
	}
	// AgentDeltaMsg appends streamed text to State.Streaming[Key] (T
	// "delta"). Deltas aren't persisted; the completed text arrives as an
	// assistant or thinking event with the same StreamKey.
	AgentDeltaMsg struct {
		T    string `json:"t"`
		Key  string `json:"key"`
		Kind string `json:"kind"` // text | thinking
		Text string `json:"text"`
	}
	// AgentErrorMsg reports a failed request from this client (T "error").
	AgentErrorMsg struct {
		T       string `json:"t"`
		Message string `json:"message"`
	}
)

type AgentState struct {
	// Status is stopped | starting | idle | working | waiting | error.
	Status         string           `json:"status"`
	Error          string           `json:"error,omitempty"`
	SessionID      string           `json:"sessionId,omitempty"`
	Model          string           `json:"model"`                 // configured; "" = claude's default
	ActiveModel    string           `json:"activeModel,omitempty"` // what the running session uses
	PermissionMode string           `json:"permissionMode"`
	Pending        []AgentRequest   `json:"pending"`
	Streaming      []AgentStreaming `json:"streaming"`
	Models         []AgentModel     `json:"models"`
	Account        *AgentAccount    `json:"account,omitempty"`
	// RateLimit is claude's latest rate_limit_info, passed through.
	RateLimit json.RawMessage `json:"rateLimit,omitempty"`
	Workspace AgentWorkspace  `json:"workspace"`
	// Context is how full the context window is, when known.
	Context *AgentContext `json:"context,omitempty"`
	// Effort is the configured effort level; "" means the model's default.
	Effort string `json:"effort"`
	// Thinking is whether extended thinking is on.
	Thinking bool `json:"thinking"`
	// Commands are the slash commands a prompt can start with.
	Commands []AgentCommand `json:"commands"`
	// Suggestion is claude's guess at the next prompt, until one is sent.
	Suggestion string `json:"suggestion,omitempty"`
	// Limits are the plan's usage windows, when known.
	Limits []AgentLimit `json:"limits,omitempty"`
	// Compacting: claude is summarizing the conversation to free context.
	Compacting bool `json:"compacting,omitempty"`
	// Recapping: the turn in progress is only a /recap. The thread's
	// status everywhere else stays idle, and its end notifies no one.
	Recapping bool `json:"recapping,omitempty"`
	// ClaudeVersion is the Claude Code version the thread's claude runs, or
	// would start with.
	ClaudeVersion string `json:"claudeVersion,omitempty"`
}

type AgentCommand struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	ArgumentHint string `json:"argumentHint,omitempty"`
}

// AgentLimit is one rate-limit window of the claude.ai plan.
type AgentLimit struct {
	Window   string  `json:"window"`   // five_hour | seven_day | seven_day_opus | ...
	Used     float64 `json:"used"`     // fraction of the window used, 0-1
	ResetsAt int64   `json:"resetsAt"` // unix ms; 0 if unknown
}

// AgentWorkspace is where a claude thread runs.
type AgentWorkspace struct {
	Mode       string `json:"mode"` // local | worktree
	BaseBranch string `json:"baseBranch,omitempty"`
	Path       string `json:"path,omitempty"` // the worktree, once created
	Branch     string `json:"branch,omitempty"`
	// Locked means the thread has started, so the workspace is fixed.
	Locked bool `json:"locked"`
}

type AgentContext struct {
	Used       int     `json:"used"` // tokens in the context window
	Max        int     `json:"max"`  // usable window size
	Percentage float64 `json:"percentage"`
	// UpdatedAt is when it was measured (Unix ms): the last time the
	// conversation was used, for noticing it's gone stale.
	UpdatedAt int64 `json:"updatedAt,omitempty"`
}

// AgentAttachment is a file uploaded for a prompt, or one an agent shared
// with attach_file (an AgentEvent of type "files").
type AgentAttachment struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"` // image | file, and for shared files video
	MediaType string `json:"mediaType"`
	Size      int64  `json:"size"`
	// Path is where a shared file's copy is on the device, to read it over a
	// file channel.
	Path string `json:"path,omitempty"`
}

// Upload channel upload:<id>, one per file: the client sends UploadStart as
// text, the file as binary chunks, then {"t":"end"}; the daemon answers
// with UploadResult and closes. The id must be 8-64 of [a-z0-9].
type (
	UploadStart struct {
		T         string `json:"t"` // "start"
		ThreadID  string `json:"threadId"`
		Name      string `json:"name"`
		MediaType string `json:"mediaType"`
		Size      int64  `json:"size"`
	}
	UploadResult struct {
		T          string           `json:"t"` // done | error
		Attachment *AgentAttachment `json:"attachment,omitempty"`
		Message    string           `json:"message,omitempty"`
	}
)

// GitInfo is the result of git.info for a project.
// CloneStatus is a clone into a new project (projects.clone).
type CloneStatus struct {
	ProjectID string `json:"projectId"`
	URL       string `json:"url"` // without credentials
	Path      string `json:"path"`
	Phase     string `json:"phase"`   // running, done or failed
	Stage     string `json:"stage"`   // connecting, counting, receiving, resolving or checkout
	Percent   int    `json:"percent"` // of the stage; -1 if unknown
	Detail    string `json:"detail,omitempty"`
	Error     string `json:"error,omitempty"`
	StartedAt int64  `json:"startedAt"`
	EndedAt   int64  `json:"endedAt,omitempty"`
}

type GitInfo struct {
	IsRepo   bool     `json:"isRepo"`
	Current  string   `json:"current"` // checked-out branch, "" if detached
	Branches []string `json:"branches"`
}

// AgentRequest is a prompt waiting for the user.
type AgentRequest struct {
	ID              string          `json:"id"`
	Kind            string          `json:"kind"` // tool | question | plan
	ToolName        string          `json:"toolName"`
	ToolUseID       string          `json:"toolUseId"`
	Input           json.RawMessage `json:"input"`
	Title           string          `json:"title,omitempty"`
	Description     string          `json:"description,omitempty"`
	DecisionReason  string          `json:"decisionReason,omitempty"`
	CanAllowSession bool            `json:"canAllowSession"`
}

type AgentStreaming struct {
	Key  string `json:"key"`
	Kind string `json:"kind"` // text | thinking
	Text string `json:"text"`
}

// AgentInfo describes the device's Claude Code install (agent.info), so the
// web app can offer models before a thread's first message.
type AgentInfo struct {
	Available bool           `json:"available"`
	Error     string         `json:"error,omitempty"` // why it isn't available
	Models    []AgentModel   `json:"models"`
	Account   *AgentAccount  `json:"account,omitempty"`
	Commands  []AgentCommand `json:"commands"`
	Limits    []AgentLimit   `json:"limits,omitempty"`
}

type AgentModel struct {
	Value       string `json:"value"`
	DisplayName string `json:"displayName"`
	Description string `json:"description,omitempty"`
	// ResolvedModel is the model id an alias (like default) stands for now.
	ResolvedModel string   `json:"resolvedModel,omitempty"`
	EffortLevels  []string `json:"effortLevels,omitempty"` // empty: no effort control
	// Thinking is whether the model can think (adaptively).
	Thinking bool `json:"thinking,omitempty"`
}

type AgentAccount struct {
	Email            string `json:"email,omitempty"`
	SubscriptionType string `json:"subscriptionType,omitempty"`
}

// AgentEvent is one persisted entry in a claude thread's log. Type selects
// which fields are set:
//   - user {id, text, attachments?}: a prompt
//   - assistant, thinking {id, text, streamKey?}: a completed block
//   - tool {id, name, input}: a tool call; id is the tool_use id
//   - toolResult {id, output, isError}: id matches the tool event
//   - request {id, kind, toolName, toolUseId, decision, answers?}: a
//     resolved prompt; decision is allow | allowSession | deny | canceled
//   - turn {status, text?, costUsd?, durationMs?}: status is started |
//     completed | interrupted | error
//   - notice {text, kind?}: e.g. compaction (kind "compact"), claude exiting
//   - turn errors carry kind "contextFull" when the context window overflowed
//     and "refreshBusy" when another claude was renewing the sign-in (the
//     daemon retries the turn)
//   - commandOutput {text}: what a local slash command printed
//
// ParentID is set on events from a subagent: the id of the tool call that
// started it.
type AgentEvent struct {
	Type       string            `json:"type"`
	ID         string            `json:"id,omitempty"`
	ParentID   string            `json:"parentId,omitempty"`
	Text       string            `json:"text,omitempty"`
	StreamKey  string            `json:"streamKey,omitempty"`
	Name       string            `json:"name,omitempty"`
	Input      json.RawMessage   `json:"input,omitempty"`
	Output     string            `json:"output,omitempty"`
	IsError    bool              `json:"isError,omitempty"`
	Kind       string            `json:"kind,omitempty"`
	ToolName   string            `json:"toolName,omitempty"`
	ToolUseID  string            `json:"toolUseId,omitempty"`
	Decision   string            `json:"decision,omitempty"`
	Answers    map[string]string `json:"answers,omitempty"`
	Status     string            `json:"status,omitempty"`
	CostUSD    float64           `json:"costUsd,omitempty"`
	DurationMS int64             `json:"durationMs,omitempty"`
	// Attachments are the files sent with a user prompt, (files) the files
	// an agent shared, with Text its caption, or (toolResult) the images in
	// a tool's result, as claude saw them.
	Attachments []AgentAttachment `json:"attachments,omitempty"`
	// FromSeq (rewind): the events from this seq up to the rewind's own were
	// removed. ID is the prompt rolled back and Text its text.
	FromSeq int64 `json:"fromSeq,omitempty"`
	// FilesRestored (rewind): how many files were restored.
	FilesRestored int `json:"filesRestored,omitempty"`
}

// ControlChunk is a piece of a control message too big to send whole; the
// client joins Data from Index 0 to Count-1 and reads the result as the
// message.
type ControlChunk struct {
	Chunk uint64 `json:"chunk"`
	Index int    `json:"index"`
	Count int    `json:"count"`
	Data  string `json:"data"`
}

// PluginInfo describes a plugin running on the device, in device.info: what
// it is, what it uses, and what it serves, so the web app can show its
// views and gate its UI on it.
type PluginInfo struct {
	ID          string            `json:"id"`
	Title       string            `json:"title"`
	Version     string            `json:"version,omitempty"`
	API         int               `json:"api"`
	Builtin     bool              `json:"builtin,omitempty"`
	Requires    []string          `json:"requires,omitempty"`
	Optional    []string          `json:"optional,omitempty"`
	Permissions []string          `json:"permissions,omitempty"`
	Contributes PluginContributes `json:"contributes"`
	// Web is an external plugin's web part, built on the device (see
	// plugins.web); empty for built-ins, whose web parts ship with the app.
	Web bool `json:"web,omitempty"`
	// Settings are what the app draws a settings form from.
	Settings []PluginSetting `json:"settings,omitempty"`
	// SettingsPage: its web part has a settings page too.
	SettingsPage bool `json:"settingsPage,omitempty"`
	// UI is what the app draws for it in its own places (sidebar, thread
	// header, device menu), from data the plugin gives.
	UI *PluginUI `json:"ui,omitempty"`
	// Icon is an installed plugin's logo, as a data: URL (SVG or PNG), drawn
	// in the app's text color for its kinds' threads and tabs.
	Icon string `json:"icon,omitempty"`
}

// PluginSetting is one setting in a plugin's settings form.
type PluginSetting struct {
	Key         string          `json:"key"`
	Type        string          `json:"type"` // string | text | number | boolean | select | secret
	Title       string          `json:"title"`
	Description string          `json:"description,omitempty"`
	Default     json.RawMessage `json:"default,omitempty"`
	// Options are a select's choices.
	Options []string `json:"options,omitempty"`
	// Scope: "device" (kept on the device, the default) or "account"
	// (kept by the account and sent to every device that has the plugin).
	Scope string `json:"scope,omitempty"`
}

// PluginUI is what a plugin shows in the app's own places. Sources name
// one of the plugin's methods, which the app calls for the data and calls
// again on "<id>.ui.changed", "<id>.kv.changed" and threads.changed.
type PluginUI struct {
	// Sidebar: a section above Projects. The method answers PluginSidebar.
	Sidebar *PluginUISource `json:"sidebar,omitempty"`
	// ThreadBadges: badges on thread rows. The method answers
	// {threadId: PluginBadge}.
	ThreadBadges *PluginUISource `json:"threadBadges,omitempty"`
	// ThreadHeader: buttons in a thread's header. The method gets
	// {threadId} and answers [PluginAction].
	ThreadHeader *PluginUISource `json:"threadHeader,omitempty"`
	// DeviceMenu: items in the device's menu in the sidebar.
	DeviceMenu []PluginAction `json:"deviceMenu,omitempty"`
}

// PluginUISource names the method that gives a UI contribution its data.
type PluginUISource struct {
	Method string `json:"method"`
}

// PluginSidebar is a plugin's sidebar section.
type PluginSidebar struct {
	Title string             `json:"title"`
	Rows  []PluginSidebarRow `json:"rows"`
}

// PluginSidebarRow is one row: a thread to open, or an action.
type PluginSidebarRow struct {
	Label  string        `json:"label"`
	Detail string        `json:"detail,omitempty"`
	Badge  *PluginBadge  `json:"badge,omitempty"`
	Icon   string        `json:"icon,omitempty"`
	Thread string        `json:"threadId,omitempty"`
	Action *PluginAction `json:"action,omitempty"`
}

// PluginBadge is a short label on a row.
type PluginBadge struct {
	Text string `json:"text"`
	Tone string `json:"tone,omitempty"` // muted (default) | live | warn
}

// PluginAction is a button or menu item: it calls one of the plugin's
// methods (with params; a thread header's also get threadId), opens a tab
// of one of its kinds, or opens a link.
type PluginAction struct {
	Label   string          `json:"label"`
	Icon    string          `json:"icon,omitempty"`
	Call    string          `json:"call,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	OpenTab string          `json:"openTab,omitempty"`
	Href    string          `json:"href,omitempty"`
}

// PluginContributes is what a plugin serves.
type PluginContributes struct {
	RPC      []string     `json:"rpc,omitempty"`
	Channels []string     `json:"channels,omitempty"`
	Sessions []string     `json:"sessions,omitempty"`
	Kinds    []PluginKind `json:"kinds,omitempty"`
	Tools    []string     `json:"tools,omitempty"`
}

// PluginKind is a thread or tab kind a plugin provides.
type PluginKind struct {
	Kind string `json:"kind"`
	// Title names it in menus (external plugins'; built-ins' web parts name theirs).
	Title string `json:"title,omitempty"`
	// Thread: threads can be of this kind; otherwise it's a tab kind only.
	Thread bool `json:"thread,omitempty"`
	// Single: a thread has at most one tab of this kind.
	Single bool `json:"single,omitempty"`
}

// FeaturePlugins: device.info lists plugins, and rtc.* sessions.
const FeaturePlugins = "plugins"

// HubFeaturePluginSettings: the daemon takes plugins' account settings
// (plugins.setAccountSettings).
const HubFeaturePluginSettings = "pluginSettings"

// EventPluginsChanged: plugins started or stopped; device.info has changed.
const EventPluginsChanged = "plugins.changed"
