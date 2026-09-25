package peer

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop"
	"github.com/conner-replogle/everywhere/daemon/internal/desktop/wire"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// callDesktop serves desktop.start, desktop.candidate and desktop.stop. They
// need the peer: a session is signaled over this browser's control channel,
// and belongs to its hub connection, so signing that browser out ends it.
func (s *Server) callDesktop(p *peer, method string, raw json.RawMessage) (any, error) {
	if s.desktop == nil {
		return nil, errors.New("remote desktop isn't available in this daemon")
	}
	var params struct {
		ID        string                 `json:"id"`
		SDP       string                 `json:"sdp"`
		Mode      string                 `json:"mode"`
		Viewer    string                 `json:"viewer"`
		Candidate *protocol.IceCandidate `json:"candidate"`
		Source    protocol.DesktopSource `json:"source"`
		TabID     string                 `json:"tabId"`
	}
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, fmt.Errorf("bad params: %w", err)
	}
	switch method {
	case "desktop.start":
		mode, ok := wire.ParseMode(params.Mode)
		if !ok {
			mode = wire.ModeSharp
		}
		name := params.Viewer
		if name == "" {
			name = "A browser"
		}
		return s.desktop.Start(params.SDP, mode, desktop.Viewer{Name: name, Client: p.from, Tab: params.TabID}, params.Source, p.sendDesktopCandidate)
	case "desktop.candidate":
		if c := params.Candidate; c != nil {
			s.desktop.AddCandidate(params.ID, webrtc.ICECandidateInit{
				Candidate: c.Candidate, SDPMid: c.SDPMid, SDPMLineIndex: c.SDPMLineIndex, UsernameFragment: c.UsernameFragment,
			})
		}
		return empty{}, nil
	default:
		s.desktop.Stop(params.ID)
		return empty{}, nil
	}
}

// sendDesktopCandidate trickles a desktop session's ICE candidate to the
// browser that started it.
func (p *peer) sendDesktopCandidate(id string, c webrtc.ICECandidateInit) {
	msg, _ := json.Marshal(protocol.DesktopCandidateEvent{
		Event: protocol.EventDesktopCandidate,
		ID:    id,
		Candidate: protocol.IceCandidate{
			Candidate: c.Candidate, SDPMid: c.SDPMid, SDPMLineIndex: c.SDPMLineIndex, UsernameFragment: c.UsernameFragment,
		},
	})
	p.mu.Lock()
	dc := p.control
	p.mu.Unlock()
	if dc != nil && dc.ReadyState() == webrtc.DataChannelStateOpen {
		_ = dc.SendText(string(msg))
	}
}
