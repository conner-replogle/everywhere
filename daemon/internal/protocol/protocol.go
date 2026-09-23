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

// HubToDaemon is either a relayed signal from a browser or an error.
type HubToDaemon struct {
	T       string     `json:"t"`
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

type Thread struct {
	ID           string `json:"id"`
	ProjectID    string `json:"projectId"`
	Name         string `json:"name"`
	CreatedAt    int64  `json:"createdAt"`
	LastOpenedAt *int64 `json:"lastOpenedAt"`
	Running      bool   `json:"running"`
}

type DirListing struct {
	Path   string   `json:"path"`
	Parent *string  `json:"parent"`
	Dirs   []string `json:"dirs"`
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
