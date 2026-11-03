package ice

import (
	"strconv"
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
)

func priority(t *testing.T, init webrtc.ICECandidateInit) uint32 {
	t.Helper()
	p, err := strconv.ParseUint(strings.Fields(init.Candidate)[3], 10, 32)
	if err != nil {
		t.Fatal(err)
	}
	return uint32(p)
}

func TestCandidateRanksTailnetBelowDirect(t *testing.T) {
	host := func(addr string) *webrtc.ICECandidate {
		return &webrtc.ICECandidate{Foundation: "1", Priority: 2130706431, Address: addr, Protocol: webrtc.ICEProtocolUDP, Port: 5000, Typ: webrtc.ICECandidateTypeHost, Component: 1}
	}
	srflx := &webrtc.ICECandidate{Foundation: "2", Priority: 1694498815, Address: "203.0.113.7", Protocol: webrtc.ICEProtocolUDP, Port: 5001, Typ: webrtc.ICECandidateTypeSrflx, Component: 1, RelatedAddress: "192.168.1.20", RelatedPort: 5000}
	relay := uint32(16777215)

	lan := priority(t, Candidate(host("192.168.1.20")))
	ts4 := priority(t, Candidate(host("100.101.102.103")))
	ts6 := priority(t, Candidate(host("fd7a:115c:a1e0::1")))
	direct := priority(t, Candidate(srflx))

	if lan != 2130706431 || direct != 1694498815 {
		t.Fatalf("direct candidates changed: lan %d srflx %d", lan, direct)
	}
	for _, ts := range []uint32{ts4, ts6} {
		if ts >= direct || ts <= relay {
			t.Errorf("tailnet priority %d not between srflx %d and relay %d", ts, direct, relay)
		}
	}
	if got := Candidate(host("100.101.102.103")).Candidate; !strings.Contains(got, " 100.101.102.103 5000 typ host") {
		t.Errorf("candidate mangled: %q", got)
	}
}
