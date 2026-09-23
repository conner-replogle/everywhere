// Package ice fetches ICE servers (Cloudflare STUN + TURN relay credentials)
// from the Worker and caches them until shortly before they expire.
package ice

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

var fallback = []webrtc.ICEServer{{URLs: []string{"stun:stun.cloudflare.com:3478"}}}

type Provider struct {
	Server     string
	Credential string

	mu      sync.Mutex
	servers []webrtc.ICEServer
	expires time.Time
}

// Servers returns cached ICE servers, refreshing them when within an hour of
// expiry. On error it falls back to STUN only (direct paths still work).
func (p *Provider) Servers() []webrtc.ICEServer {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.servers != nil && time.Until(p.expires) > time.Hour {
		return p.servers
	}
	servers, expires, err := p.fetch()
	if err != nil {
		slog.Warn("fetching ICE servers; using STUN only", "err", err)
		if p.servers != nil && time.Now().Before(p.expires) {
			return p.servers
		}
		return fallback
	}
	p.servers, p.expires = servers, expires
	return servers
}

func (p *Provider) fetch() ([]webrtc.ICEServer, time.Time, error) {
	req, err := http.NewRequest("GET", strings.TrimRight(p.Server, "/")+"/api/daemon/ice-servers", nil)
	if err != nil {
		return nil, time.Time{}, err
	}
	req.Header.Set("Authorization", "Bearer "+p.Credential)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, time.Time{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, time.Time{}, fmt.Errorf("GET ice-servers: %s", resp.Status)
	}
	var out struct {
		IceServers []struct {
			URLs       []string `json:"urls"`
			Username   string   `json:"username"`
			Credential string   `json:"credential"`
		} `json:"iceServers"`
		ExpiresAt int64 `json:"expiresAt"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, time.Time{}, err
	}
	servers := make([]webrtc.ICEServer, 0, len(out.IceServers))
	for _, s := range out.IceServers {
		servers = append(servers, webrtc.ICEServer{URLs: s.URLs, Username: s.Username, Credential: s.Credential})
	}
	return servers, time.UnixMilli(out.ExpiresAt), nil
}
