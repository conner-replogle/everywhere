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

// HubRPCResult answers a hub "rpc" request (T "rpc.result").
type HubRPCResult struct {
	T      string    `json:"t"`
	ID     string    `json:"id"`
	Result any       `json:"result,omitempty"`
	Error  *RPCError `json:"error,omitempty"`
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
)

type DeviceInfo struct {
	Hostname string `json:"hostname"`
	Home     string `json:"home"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
	Version  string `json:"version"`
	// Features lists what this daemon supports beyond V1, so the web app can
	// adapt to older daemons.
	Features []string `json:"features"`
}

const (
	FeatureClaude      = "claude"      // claude threads and the agent channel
	FeatureUpdate      = "update"      // device.checkUpdate and device.update
	FeatureWorktrees   = "worktrees"   // claude threads in their own worktree; git.info
	FeatureAttachments = "attachments" // upload channels and send attachments
	FeatureHistory     = "history"     // agent attach limit and history paging
	FeatureArchive     = "archive"     // threads.archive and Thread.archivedAt
	FeatureTabs        = "tabs"        // tabs.*, fs.list, threads.workdir and file channels
)

// UpdateInfo is the result of device.checkUpdate.
type UpdateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Available bool   `json:"available"`
	// Reason says why this daemon can't update itself (e.g. a dev build).
	Reason string `json:"reason,omitempty"`
}

// UpdateResult is the result of device.update, sent just before the daemon
// restarts into the new version.
type UpdateResult struct {
	Version string `json:"version"`
}

type Project struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	IsHome    bool   `json:"isHome"`
	CreatedAt int64  `json:"createdAt"`
}

const (
	ThreadTerminal = "terminal"
	ThreadClaude   = "claude"
	// Tabs only.
	ThreadBrowser = "browser"
	ThreadFiles   = "files"
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
	EventThreadsChanged  = "threads.changed"
)

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
}

// AgentAttachment is a file uploaded for a prompt.
type AgentAttachment struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"` // image | file
	MediaType string `json:"mediaType"`
	Size      int64  `json:"size"`
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
	Value        string   `json:"value"`
	DisplayName  string   `json:"displayName"`
	Description  string   `json:"description,omitempty"`
	EffortLevels []string `json:"effortLevels,omitempty"` // empty: no effort control
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
//   - notice {text}: e.g. compaction, claude exiting
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
	// Attachments are the files sent with a user prompt.
	Attachments []AgentAttachment `json:"attachments,omitempty"`
}
