package external

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

// A plugin's settings live in its KV under host scopes: device values in
// "settings", account values (sent by the hub) in "settings.account".
const (
	settingsScope        = "settings"
	accountSettingsScope = "settings.account"
)

// CheckSetting checks a value against its setting's type.
func CheckSetting(st protocol.PluginSetting, v json.RawMessage) error {
	var x any
	if err := json.Unmarshal(v, &x); err != nil {
		return errors.New("not JSON")
	}
	switch st.Type {
	case "string", "text", "secret":
		s, ok := x.(string)
		if !ok {
			return errors.New("not text")
		}
		if len(s) > 64<<10 {
			return errors.New("too long")
		}
	case "number":
		if _, ok := x.(float64); !ok {
			return errors.New("not a number")
		}
	case "boolean":
		if _, ok := x.(bool); !ok {
			return errors.New("not true or false")
		}
	case "select":
		s, ok := x.(string)
		if !ok || !slices.Contains(st.Options, s) {
			return fmt.Errorf("not one of %v", st.Options)
		}
	}
	return nil
}

// accountKey is where the hub's account values are kept, whole: they can
// arrive before the plugin is installed here, so they're checked when read.
const accountKey = "values"

// stored is a setting's stored value, if it has one.
func stored(st *store.Store, plugin string, s protocol.PluginSetting) (json.RawMessage, bool) {
	if s.Scope == "account" {
		raw, ok, err := st.KVGet(plugin, accountSettingsScope, accountKey)
		if err != nil || !ok {
			return nil, false
		}
		var all map[string]json.RawMessage
		if json.Unmarshal(raw, &all) != nil {
			return nil, false
		}
		v, ok := all[s.Key]
		return v, ok && string(v) != "null"
	}
	v, ok, err := st.KVGet(plugin, settingsScope, s.Key)
	return v, err == nil && ok
}

// Values are a plugin's settings as it sees them: each one's value, or its
// default. A stored value that no longer fits its type falls back too.
func Values(st *store.Store, m Manifest) map[string]json.RawMessage {
	out := map[string]json.RawMessage{}
	for _, s := range m.Settings {
		if v, ok := stored(st, m.ID, s); ok && CheckSetting(s, v) == nil {
			out[s.Key] = v
		} else if len(s.Default) > 0 {
			out[s.Key] = s.Default
		}
	}
	return out
}

// SetAccount keeps the account's values for a plugin, whole, as the hub
// sent them (installed here or not).
func SetAccount(st *store.Store, plugin string, values map[string]json.RawMessage) error {
	if !idRe.MatchString(plugin) {
		return fmt.Errorf("bad plugin id %q", plugin)
	}
	if len(values) == 0 {
		return st.KVDelete(plugin, accountSettingsScope, accountKey)
	}
	raw, err := json.Marshal(values)
	if err != nil {
		return err
	}
	return st.KVSet(plugin, accountSettingsScope, accountKey, raw)
}

// SettingView is a setting's value as the browser sees it: secrets only
// say whether they're set, and how they end.
type SettingView struct {
	Value json.RawMessage `json:"value,omitempty"`
	Set   bool            `json:"set"`
	Hint  string          `json:"hint,omitempty"`
}

// View is the settings form's data.
func View(st *store.Store, m Manifest) map[string]SettingView {
	out := map[string]SettingView{}
	for _, s := range m.Settings {
		v, ok := stored(st, m.ID, s)
		if !ok {
			out[s.Key] = SettingView{Value: s.Default}
			continue
		}
		if s.Type == "secret" {
			var secret string
			_ = json.Unmarshal(v, &secret)
			hint := ""
			if len(secret) > 4 {
				hint = secret[len(secret)-4:]
			}
			out[s.Key] = SettingView{Set: true, Hint: hint}
			continue
		}
		out[s.Key] = SettingView{Value: v, Set: true}
	}
	return out
}

// SetDevice stores device values (a key's null clears it) from the
// device's settings form. Account settings are refused: they're the hub's.
func SetDevice(st *store.Store, m Manifest, values map[string]json.RawMessage) error {
	byKey := map[string]protocol.PluginSetting{}
	for _, s := range m.Settings {
		byKey[s.Key] = s
	}
	for k, v := range values {
		s, ok := byKey[k]
		if !ok {
			return fmt.Errorf("%s has no setting %q", m.ID, k)
		}
		if s.Scope == "account" {
			return fmt.Errorf("%s is kept by the account, not the device", k)
		}
		if string(v) != "null" && len(v) > 0 {
			if err := CheckSetting(s, v); err != nil {
				return fmt.Errorf("%s: %w", k, err)
			}
		}
	}
	for k, v := range values {
		if string(v) == "null" || len(v) == 0 {
			if err := st.KVDelete(m.ID, settingsScope, k); err != nil {
				return err
			}
		} else if err := st.KVSet(m.ID, settingsScope, k, v); err != nil {
			return err
		}
	}
	return nil
}
