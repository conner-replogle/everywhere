package plugin

import (
	"context"
	"encoding/json"

	"github.com/pion/webrtc/v4"
)

// Sessions are WebRTC connections of their own (media), signaled over the
// control channel by the core:
//
//	rtc.open      {kind, sdp, params}  → {id, sdp}     the browser offers
//	rtc.candidate {id, candidate}                       both ways (event rtc.candidate from the daemon)
//	rtc.close     {id}
//
// A session belongs to the browser tab that opened it and is closed with it.
// The plugin either builds the answering PeerConnection itself (with the
// core's SettingEngine and ICE servers, from Host.WebRTC) and adds its
// tracks, or relays the offer to whatever answers (Chromium's capture
// extension). Either way the core carries the signaling and the lifetime.
// rtc.* is never reachable over the hub.

// Session is one open session.
type Session interface {
	ID() string
	// Peer is the browser tab that opened it.
	Peer() Peer
	// SendCandidate trickles a local ICE candidate to the browser.
	SendCandidate(c webrtc.ICECandidateInit)
	// Close ends it from the plugin's side (the browser is told).
	Close(reason string)
}

// SessionHandler serves one kind of session.
type SessionHandler struct {
	// Open answers the browser's offer. ctx ends when the session closes.
	Open func(ctx context.Context, s Session, offer string, params json.RawMessage) (answer string, err error)
	// Candidate adds a remote ICE candidate.
	Candidate func(s Session, c webrtc.ICECandidateInit)
	// Closed is called once when the session ends, from either side.
	Closed func(s Session)
	// Single: one session of this kind on the device at a time; a new one
	// takes over (the old one's browser is told).
	Single bool
}

// Session events sent to the browser.
const (
	EventRTCCandidate = "rtc.candidate"
	EventRTCClosed    = "rtc.closed"
)

// RTCCandidateEvent trickles a daemon-side candidate.
type RTCCandidateEvent struct {
	Event     string                  `json:"event"`
	ID        string                  `json:"id"`
	Candidate webrtc.ICECandidateInit `json:"candidate"`
}

// RTCClosedEvent says a session ended on the daemon's side.
type RTCClosedEvent struct {
	Event  string `json:"event"`
	ID     string `json:"id"`
	Reason string `json:"reason,omitempty"`
}
