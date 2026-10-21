package plugin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/pion/webrtc/v4"
)

// session is an open rtc session.
type session struct {
	r      *Registry
	id     string
	kind   string
	plugin string
	peer   Peer
	h      SessionHandler
	ctx    context.Context
	cancel context.CancelFunc
	once   sync.Once
}

func (s *session) ID() string { return s.id }
func (s *session) Peer() Peer { return s.peer }

func (s *session) SendCandidate(c webrtc.ICECandidateInit) {
	s.peer.Send(RTCCandidateEvent{Event: EventRTCCandidate, ID: s.id, Candidate: c})
}

func (s *session) Close(reason string) { s.close(reason, true) }

// close ends the session; tell says whether the browser should hear of it
// (not when it asked).
func (s *session) close(reason string, tell bool) {
	s.once.Do(func() {
		s.r.sessMu.Lock()
		delete(s.r.sessions, s.id)
		s.r.sessMu.Unlock()
		s.cancel()
		if s.h.Closed != nil {
			func() {
				defer func() {
					if v := recover(); v != nil {
						slog.Error("session close panicked", "kind", s.kind, "panic", v)
					}
				}()
				s.h.Closed(s)
			}()
		}
		if tell {
			s.peer.Send(RTCClosedEvent{Event: EventRTCClosed, ID: s.id, Reason: reason})
		}
	})
}

func newSessionID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// registerSessionMethods serves rtc.* for every plugin's sessions. They
// need a browser connection, so they're never reachable over the hub.
func (r *Registry) registerSessionMethods(h Host) {
	h.HandleRPC("rtc.open", func(_ context.Context, c RPCContext, raw json.RawMessage) (any, error) {
		var p struct {
			Kind   string          `json:"kind"`
			SDP    string          `json:"sdp"`
			Params json.RawMessage `json:"params"`
		}
		if err := Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		if c.Peer == nil {
			return nil, errors.New("rtc.open needs a browser connection")
		}
		r.mu.RLock()
		reg, ok := r.sessKind[p.Kind]
		r.mu.RUnlock()
		if !ok {
			return nil, fmt.Errorf("no plugin serves %q sessions", p.Kind)
		}
		if reg.h.Single {
			r.sessMu.Lock()
			var old []*session
			for _, s := range r.sessions {
				if s.kind == p.Kind {
					old = append(old, s)
				}
			}
			r.sessMu.Unlock()
			for _, s := range old {
				s.Close("Another browser took over")
			}
		}
		ctx, cancel := context.WithCancel(context.Background())
		s := &session{r: r, id: newSessionID(), kind: p.Kind, plugin: reg.plugin, peer: c.Peer, h: reg.h, ctx: ctx, cancel: cancel}
		r.sessMu.Lock()
		r.sessions[s.id] = s
		r.sessMu.Unlock()
		answer, err := reg.h.Open(ctx, s, p.SDP, p.Params)
		if err != nil {
			s.close("", false)
			return nil, err
		}
		return struct {
			ID  string `json:"id"`
			SDP string `json:"sdp"`
		}{s.id, answer}, nil
	}, Slow())
	h.HandleRPC("rtc.candidate", func(_ context.Context, c RPCContext, raw json.RawMessage) (any, error) {
		var p struct {
			ID        string                   `json:"id"`
			Candidate *webrtc.ICECandidateInit `json:"candidate"`
		}
		if err := Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		s := r.session(p.ID, c.Peer)
		if s != nil && p.Candidate != nil && s.h.Candidate != nil {
			s.h.Candidate(s, *p.Candidate)
		}
		return Empty{}, nil
	})
	h.HandleRPC("rtc.close", func(_ context.Context, c RPCContext, raw json.RawMessage) (any, error) {
		var p struct {
			ID string `json:"id"`
		}
		if err := Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		if s := r.session(p.ID, c.Peer); s != nil {
			s.close("", false)
		}
		return Empty{}, nil
	})
}

// session finds a session the peer opened.
func (r *Registry) session(id string, p Peer) *session {
	r.sessMu.Lock()
	defer r.sessMu.Unlock()
	s := r.sessions[id]
	if s == nil || p == nil || s.peer.ID() != p.ID() {
		return nil
	}
	return s
}

// PeerClosed ends the sessions a browser connection opened.
func (r *Registry) PeerClosed(p Peer) {
	r.sessMu.Lock()
	var closing []*session
	for _, s := range r.sessions {
		if s.peer.ID() == p.ID() {
			closing = append(closing, s)
		}
	}
	r.sessMu.Unlock()
	for _, s := range closing {
		s.close("", false)
	}
}
