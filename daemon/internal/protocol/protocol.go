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
	ControlChannel    = "control"
	TermChannelPrefix = "term:"
)

type DeviceInfo struct {
	Hostname string `json:"hostname"`
	Home     string `json:"home"`
	OS       string `json:"os"`
	Arch     string `json:"arch"`
	Version  string `json:"version"`
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
