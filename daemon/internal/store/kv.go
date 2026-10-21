package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Limits on a plugin's key/value state.
const (
	KVMaxKey   = 256
	KVMaxValue = 1 << 20
	// KVMaxTotal is what one plugin may keep in all.
	KVMaxTotal = 16 << 20
)

// KVEntry is one key's value.
type KVEntry struct {
	Scope     string          `json:"scope"`
	Key       string          `json:"key"`
	Value     json.RawMessage `json:"value"`
	UpdatedAt int64           `json:"updatedAt"`
}

// ValidKVScope reports whether scope is "", "thread:<id>", "project:<id>"
// or one of the host's own ("settings", "settings.account").
func ValidKVScope(scope string) bool {
	if scope == "" || scope == "settings" || scope == "settings.account" {
		return true
	}
	kind, id, ok := strings.Cut(scope, ":")
	return ok && (kind == "thread" || kind == "project") && id != "" && len(id) <= 64
}

// KVGet reads a key; ok is false if it isn't set.
func (s *Store) KVGet(plugin, scope, key string) (json.RawMessage, bool, error) {
	var v string
	err := s.db.QueryRow("SELECT value FROM plugin_kv WHERE plugin = ? AND scope = ? AND key = ?", plugin, scope, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return json.RawMessage(v), true, nil
}

// KVSet sets a key to a JSON value, within the plugin's limits.
func (s *Store) KVSet(plugin, scope, key string, value json.RawMessage) error {
	if key == "" || len(key) > KVMaxKey {
		return fmt.Errorf("a key is 1-%d bytes", KVMaxKey)
	}
	if !ValidKVScope(scope) {
		return fmt.Errorf("bad scope %q: use \"\", \"thread:<id>\" or \"project:<id>\"", scope)
	}
	if !json.Valid(value) {
		return errors.New("the value isn't JSON")
	}
	if len(value) > KVMaxValue {
		return fmt.Errorf("a value is at most %d KB", KVMaxValue>>10)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var total int64
	if err := tx.QueryRow(
		"SELECT COALESCE(SUM(LENGTH(value) + LENGTH(key)), 0) FROM plugin_kv WHERE plugin = ? AND NOT (scope = ? AND key = ?)",
		plugin, scope, key,
	).Scan(&total); err != nil {
		return err
	}
	if total+int64(len(value)+len(key)) > KVMaxTotal {
		return fmt.Errorf("the plugin's state would be over %d MB", KVMaxTotal>>20)
	}
	if _, err := tx.Exec(`INSERT INTO plugin_kv (plugin, scope, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
ON CONFLICT (plugin, scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		plugin, scope, key, string(value), now()); err != nil {
		return err
	}
	return tx.Commit()
}

// KVDelete removes a key.
func (s *Store) KVDelete(plugin, scope, key string) error {
	_, err := s.db.Exec("DELETE FROM plugin_kv WHERE plugin = ? AND scope = ? AND key = ?", plugin, scope, key)
	return err
}

// KVList lists a scope's keys starting with prefix, in key order.
func (s *Store) KVList(plugin, scope, prefix string, limit int) ([]KVEntry, error) {
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}
	rows, err := s.db.Query(`SELECT scope, key, value, updated_at FROM plugin_kv
WHERE plugin = ? AND scope = ? AND substr(key, 1, ?) = ? ORDER BY key LIMIT ?`, plugin, scope, len(prefix), prefix, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []KVEntry{}
	for rows.Next() {
		var e KVEntry
		var v string
		if err := rows.Scan(&e.Scope, &e.Key, &v, &e.UpdatedAt); err != nil {
			return nil, err
		}
		e.Value = json.RawMessage(v)
		out = append(out, e)
	}
	return out, rows.Err()
}

// KVScopes lists the scopes a plugin keeps keys in whose names start with
// prefix (e.g. "thread:"), for a plugin to find what it has.
func (s *Store) KVScopes(plugin, prefix string) ([]string, error) {
	rows, err := s.db.Query(`SELECT DISTINCT scope FROM plugin_kv WHERE plugin = ? AND substr(scope, 1, ?) = ? ORDER BY scope`,
		plugin, len(prefix), prefix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var sc string
		if err := rows.Scan(&sc); err != nil {
			return nil, err
		}
		out = append(out, sc)
	}
	return out, rows.Err()
}

// KVDeleteScope removes every plugin's keys in a scope (a deleted thread's).
func (s *Store) KVDeleteScope(scope string) error {
	_, err := s.db.Exec("DELETE FROM plugin_kv WHERE scope = ?", scope)
	return err
}

// KVDeletePlugin removes all of a plugin's state (uninstalling with --purge).
func (s *Store) KVDeletePlugin(plugin string) error {
	_, err := s.db.Exec("DELETE FROM plugin_kv WHERE plugin = ?", plugin)
	return err
}
