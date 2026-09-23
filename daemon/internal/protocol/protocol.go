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

// HubToDaemon is a relayed signal from a browser, an error, or
// "client.revoked" (a browser connection's session was signed out).
type HubToDaemon struct {
	T       string     `json:"t"`
	ConnID  string     `json:"connId,omitempty"`
	From    string     `json:"from,omitempty"`
	SID     string     `json:"sid,omitempty"`
	Data    SignalData `json:"data"`
	Code    string     `json:"code,omitempty"`
	Message string     `json:"message,omitempty"`
}

type Hello struct {
	T       string `json:"t"` // "hello"
	Version string `json:"version"`
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
	ControlChannel     = "control"
	TermChannelPrefix  = "term:"
	AgentChannelPrefix = "agent:"
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
	FeatureClaude = "claude" // claude threads and the agent channel
	FeatureUpdate = "update" // device.checkUpdate and device.update
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
)

type Thread struct {
	ID           string `json:"id"`
	ProjectID    string `json:"projectId"`
	Kind         string `json:"kind"` // terminal | claude
	Name         string `json:"name"`
	CreatedAt    int64  `json:"createdAt"`
	LastOpenedAt *int64 `json:"lastOpenedAt"`
	// Running reports a live shell (terminal) or claude process (claude).
	Running bool `json:"running"`
	// AgentStatus is set for claude threads; see AgentState.Status.
	AgentStatus string `json:"agentStatus,omitempty"`
}

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
//   - attach {afterSeq}: must come first; replays events after afterSeq
//   - send {text}: a prompt; starts or resumes claude as needed
//   - interrupt
//   - respond {requestId, decision, message?, answers?}
//   - setMode {mode}, setModel {model}
type AgentClientMsg struct {
	T         string            `json:"t"`
	AfterSeq  int64             `json:"afterSeq,omitempty"`
	Text      string            `json:"text,omitempty"`
	RequestID string            `json:"requestId,omitempty"`
	Decision  string            `json:"decision,omitempty"` // allow | allowSession | deny
	Message   string            `json:"message,omitempty"`  // deny: feedback for claude
	Answers   map[string]string `json:"answers,omitempty"`  // question requests: question -> answer
	Mode      string            `json:"mode,omitempty"`
	Model     string            `json:"model,omitempty"`
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

type AgentModel struct {
	Value       string `json:"value"`
	DisplayName string `json:"displayName"`
	Description string `json:"description,omitempty"`
}

type AgentAccount struct {
	Email            string `json:"email,omitempty"`
	SubscriptionType string `json:"subscriptionType,omitempty"`
}

// AgentEvent is one persisted entry in a claude thread's log. Type selects
// which fields are set:
//   - user {id, text}: a prompt
//   - assistant, thinking {id, text, streamKey?}: a completed block
//   - tool {id, name, input}: a tool call; id is the tool_use id
//   - toolResult {id, output, isError}: id matches the tool event
//   - request {id, kind, toolName, toolUseId, decision, answers?}: a
//     resolved prompt; decision is allow | allowSession | deny | canceled
//   - turn {status, text?, costUsd?, durationMs?}: status is started |
//     completed | interrupted | error
//   - notice {text}: e.g. compaction, claude exiting
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
}
