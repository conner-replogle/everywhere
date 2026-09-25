package desktop

import (
	"encoding/json"
	"log/slog"
	"net/netip"
	"os/exec"
)

// notify shows a desktop notification in the session.
func notify(h *hyprInstance, summary, body string) {
	go func() {
		cmd := exec.Command("notify-send", "--app-name=Everywhere", "--icon=preferences-desktop-remote-desktop", summary, body)
		if h != nil {
			cmd.Env = h.env()
		}
		if err := cmd.Run(); err != nil {
			slog.Debug("notify-send", "err", err)
		}
	}()
}

// inhibitSleep blocks system suspend until the returned func is called. Screen
// locking still works: injected input resets hypridle, and an idle remote
// viewer should lock (and can type the password).
func inhibitSleep(why string) func() {
	cmd := exec.Command("systemd-inhibit", "--what=sleep", "--who=everywhere", "--why="+why, "--mode=block", "sleep", "infinity")
	if err := cmd.Start(); err != nil {
		slog.Warn("cannot inhibit sleep", "err", err)
		return func() {}
	}
	go func() { _ = cmd.Wait() }()
	return func() { _ = cmd.Process.Kill() }
}

// tailnetPath reports whether Tailscale is relaying traffic to ip through DERP.
// known is false when ip isn't a tailnet peer (or tailscale isn't installed).
func tailnetPath(ip netip.Addr) (known, relayed bool, relay string) {
	out, err := exec.Command("tailscale", "status", "--json").Output()
	if err != nil {
		return false, false, ""
	}
	var st struct {
		Peer map[string]struct {
			TailscaleIPs []string
			CurAddr      string
			Relay        string
		}
	}
	if json.Unmarshal(out, &st) != nil {
		return false, false, ""
	}
	for _, p := range st.Peer {
		for _, s := range p.TailscaleIPs {
			if a, err := netip.ParseAddr(s); err == nil && a == ip {
				return true, p.CurAddr == "" && p.Relay != "", p.Relay
			}
		}
	}
	return false, false, ""
}

var tailscaleV4 = netip.MustParsePrefix("100.64.0.0/10")
var tailscaleV6 = netip.MustParsePrefix("fd7a:115c:a1e0::/48")

func isTailscale(ip netip.Addr) bool {
	ip = ip.Unmap()
	return tailscaleV4.Contains(ip) || tailscaleV6.Contains(ip)
}
