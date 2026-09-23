package peer

import (
	"net"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

func candidateInfo(c *webrtc.ICECandidate) protocol.CandidateInfo {
	return protocol.CandidateInfo{
		Type:     c.Typ.String(),
		Protocol: c.Protocol.String(),
		Address:  c.Address,
		Port:     c.Port,
	}
}

// debug reports this peer connection as the daemon sees it.
func (p *peer) debug() protocol.PeerDebug {
	d := protocol.PeerDebug{
		SID:                p.sid,
		ConnectionState:    p.pc.ConnectionState().String(),
		ICEConnectionState: p.pc.ICEConnectionState().String(),
		LocalCandidates:    []protocol.CandidateInfo{},
		RemoteCandidates:   []protocol.CandidateInfo{},
		Interfaces:         interfaces(),
		ConnectedForMs:     time.Since(p.started).Milliseconds(),
	}
	p.mu.Lock()
	d.OpenTerminals = len(p.terms)
	p.mu.Unlock()

	if sctp := p.pc.SCTP(); sctp != nil && sctp.Transport() != nil {
		ice := sctp.Transport().ICETransport()
		if pair, err := ice.GetSelectedCandidatePair(); err == nil && pair != nil {
			d.SelectedPair = &protocol.CandidatePair{Local: candidateInfo(pair.Local), Remote: candidateInfo(pair.Remote)}
		}
	}
	for _, st := range p.pc.GetStats() {
		c, ok := st.(webrtc.ICECandidateStats)
		if !ok {
			continue
		}
		info := protocol.CandidateInfo{
			Type: c.CandidateType.String(), Protocol: c.Protocol, Address: c.IP, Port: uint16(c.Port),
		}
		switch c.Type {
		case webrtc.StatsTypeLocalCandidate:
			d.LocalCandidates = append(d.LocalCandidates, info)
		case webrtc.StatsTypeRemoteCandidate:
			d.RemoteCandidates = append(d.RemoteCandidates, info)
		}
	}
	return d
}

func interfaces() []protocol.NetInterface {
	out := []protocol.NetInterface{}
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		ni := protocol.NetInterface{Name: iface.Name, Addresses: []string{}}
		for _, a := range addrs {
			ni.Addresses = append(ni.Addresses, a.String())
		}
		if len(ni.Addresses) > 0 {
			out = append(out, ni)
		}
	}
	return out
}
