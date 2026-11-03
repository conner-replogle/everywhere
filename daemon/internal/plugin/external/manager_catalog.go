package external

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
)

// CatalogPlugin is a registry plugin as plugins.catalog reports it: the
// registry's entry, and how it stands on this device.
type CatalogPlugin struct {
	Manifest Manifest `json:"manifest"`
	Icon     string   `json:"icon,omitempty"`
	Homepage string   `json:"homepage,omitempty"`
	// Installed is the version installed here, if any (from anywhere).
	Installed string `json:"installed,omitempty"`
	Enabled   bool   `json:"enabled,omitempty"`
	// Update: the registry has a newer version than the one installed from it.
	Update bool `json:"update,omitempty"`
	// Problem is why it can't be installed here.
	Problem string `json:"problem,omitempty"`
	// LocalConsent: it asks for permissions only the device's CLI can grant.
	LocalConsent []string `json:"localConsent,omitempty"`
}

// The registry's plugins can be installed, updated, turned on and removed
// from the app as well as the CLI: the app can already run commands on the
// device, so the CLI alone adds friction, not safety. What still takes the
// device itself: plugins from anywhere but the registry, and permissions
// that need local consent (the screen). None of these is reachable over the
// hub (not Remote), so the Worker can't install code.
func (m *Manager) serveCatalog(h plugin.Host) {
	h.HandleRPC("plugins.catalog", func(ctx context.Context, _ plugin.RPCContext, raw json.RawMessage) (any, error) {
		var r struct {
			Fresh bool `json:"fresh"`
		}
		if err := plugin.Unmarshal(raw, &r); err != nil {
			return nil, err
		}
		url := RegistryURL()
		cat, err := FetchCatalog(ctx, url, r.Fresh)
		if err != nil {
			return nil, err
		}
		m.mu.Lock()
		installed := m.installed
		m.mu.Unlock()
		out := []CatalogPlugin{}
		for _, e := range cat.Plugins {
			c := CatalogPlugin{Manifest: e.Manifest, Icon: e.Icon, Homepage: e.Homepage, Problem: e.Problem(), LocalConsent: e.LocalConsent()}
			if man, ok := installed[e.Manifest.ID]; ok {
				c.Installed, c.Enabled = man.Version, m.enabled(man.ID)
				src, fromRegistry := InstalledFrom(filepath.Join(m.root, man.ID))
				c.Update = fromRegistry && src.Version != e.Manifest.Version && c.Problem == ""
			}
			out = append(out, c)
		}
		return map[string]any{"registry": url, "platform": Platform(), "plugins": out}, nil
	}, plugin.Slow())

	// Install (or update) a registry plugin and turn it on.
	h.HandleRPC("plugins.install", func(ctx context.Context, _ plugin.RPCContext, raw json.RawMessage) (any, error) {
		var r struct {
			ID string `json:"id"`
		}
		if err := plugin.Unmarshal(raw, &r); err != nil {
			return nil, err
		}
		url := RegistryURL()
		cat, err := FetchCatalog(ctx, url, true)
		if err != nil {
			return nil, err
		}
		e, ok := cat.Find(r.ID)
		if !ok {
			return nil, fmt.Errorf("the registry has no plugin %q", r.ID)
		}
		if lc := e.LocalConsent(); len(lc) > 0 {
			return nil, fmt.Errorf("%s asks to %s: install it on the device itself, with `everywhere plugin install %s`", e.Manifest.Title, strings.Join(lc, ", "), r.ID)
		}
		if err := InstallFrom(ctx, url, e, m.root); err != nil {
			return nil, err
		}
		if err := m.setEnabled(r.ID, true); err != nil {
			return nil, err
		}
		m.Reconcile()
		return plugin.Empty{}, nil
	}, plugin.Slow())

	h.HandleRPC("plugins.enable", plugin.Params(func(_ plugin.RPCContext, r struct {
		ID string `json:"id"`
	}) (any, error) {
		m.mu.Lock()
		man, ok := m.installed[r.ID]
		m.mu.Unlock()
		if !ok {
			return nil, errors.New("no such plugin")
		}
		if lc := (CatalogEntry{Manifest: man}).LocalConsent(); len(lc) > 0 {
			return nil, fmt.Errorf("%s asks to %s: turn it on on the device itself, with `everywhere plugin enable %s`", man.Title, strings.Join(lc, ", "), r.ID)
		}
		if err := m.setEnabled(r.ID, true); err != nil {
			return nil, err
		}
		m.Reconcile()
		return plugin.Empty{}, nil
	}))

	// Remove a plugin's files; its data, state and settings stay, for a
	// reinstall (`everywhere plugin remove --purge` drops them).
	h.HandleRPC("plugins.remove", plugin.Params(func(_ plugin.RPCContext, r struct {
		ID string `json:"id"`
	}) (any, error) {
		m.mu.Lock()
		_, ok := m.installed[r.ID]
		m.mu.Unlock()
		if !ok {
			return nil, errors.New("no such plugin")
		}
		if err := m.setEnabled(r.ID, false); err != nil {
			return nil, err
		}
		if err := os.RemoveAll(filepath.Join(m.root, r.ID)); err != nil {
			return nil, err
		}
		m.Reconcile()
		return plugin.Empty{}, nil
	}))
}
