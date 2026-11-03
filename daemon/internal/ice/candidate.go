package ice

import (
	"net/netip"
	"strconv"
	"strings"

	"github.com/pion/webrtc/v4"
)

var tailscaleV4 = netip.MustParsePrefix("100.64.0.0/10")
var tailscaleV6 = netip.MustParsePrefix("fd7a:115c:a1e0::/48")

// IsTailscale reports whether ip is a tailnet address: 100.64.0.0/10
// (Tailscale's CGNAT range) or its fd7a:115c:a1e0::/48 ULA.
func IsTailscale(ip netip.Addr) bool {
	ip = ip.Unmap()
	return tailscaleV4.Contains(ip) || tailscaleV6.Contains(ip)
}

// tailnetTypePreference ranks the daemon's tailnet host candidates below
// server-reflexive ones (100) and above relays (0).
const tailnetTypePreference = 90

// Candidate is c as signaled to the browser. pion gives every host candidate
// the same priority, so a tailnet address ties with the LAN one and the
// browser (the controlling side, which picks the path) may settle on
// Tailscale even when a direct path works. Tailnet host candidates are
// advertised below the direct ones instead: the browser connects over the LAN
// or through NAT traversal when it can, then Tailscale, then TURN.
func Candidate(c *webrtc.ICECandidate) webrtc.ICECandidateInit {
	init := c.ToJSON()
	if c.Typ != webrtc.ICECandidateTypeHost {
		return init
	}
	if ip, err := netip.ParseAddr(c.Address); err != nil || !IsTailscale(ip) {
		return init
	}
	// candidate:<foundation> <component> <transport> <priority> <address> ...
	f := strings.Fields(init.Candidate)
	if len(f) < 4 {
		return init
	}
	priority := uint32(tailnetTypePreference)<<24 | uint32(c.Priority)&0xffffff
	f[3] = strconv.FormatUint(uint64(priority), 10)
	init.Candidate = strings.Join(f, " ")
	return init
}
