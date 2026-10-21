package plugin

import (
	"encoding/json"
	"errors"
	"strings"

	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

// KV is a plugin's key/value state on the device: plugin-wide (scope ""),
// or a thread's or project's ("thread:<id>", "project:<id>"), which goes
// when the thread or project is deleted. Values are JSON. Changes are told
// to browsers as "<id>.kv.changed" {scope, key}, so its web part can follow.
type KV interface {
	Get(scope, key string) (json.RawMessage, bool, error)
	Set(scope, key string, value json.RawMessage) error
	Delete(scope, key string) error
	// List lists a scope's keys starting with prefix.
	List(scope, prefix string) ([]store.KVEntry, error)
	// Scopes lists the scopes it has keys in starting with prefix ("thread:").
	Scopes(prefix string) ([]string, error)
}

// KVChangedEvent tells browsers a plugin's key changed.
type KVChangedEvent struct {
	Event string `json:"event"` // "<plugin>.kv.changed"
	Scope string `json:"scope"`
	Key   string `json:"key"`
}

// NewKV is plugin's KV on st; emit (if set) tells browsers of changes.
func NewKV(st *store.Store, plugin string, emit func(any)) KV {
	return kv{st, plugin, emit}
}

type kv struct {
	st     *store.Store
	plugin string
	emit   func(any)
}

// errHostScope: "settings" is the host's, written through settings.
var errHostScope = errors.New(`the "settings" scope is the host's; use settings`)

func (k kv) Get(scope, key string) (json.RawMessage, bool, error) {
	if strings.HasPrefix(scope, "settings") {
		return nil, false, errHostScope
	}
	return k.st.KVGet(k.plugin, scope, key)
}

func (k kv) Set(scope, key string, value json.RawMessage) error {
	if strings.HasPrefix(scope, "settings") {
		return errHostScope
	}
	if err := k.st.KVSet(k.plugin, scope, key, value); err != nil {
		return err
	}
	k.changed(scope, key)
	return nil
}

func (k kv) Delete(scope, key string) error {
	if strings.HasPrefix(scope, "settings") {
		return errHostScope
	}
	if err := k.st.KVDelete(k.plugin, scope, key); err != nil {
		return err
	}
	k.changed(scope, key)
	return nil
}

func (k kv) List(scope, prefix string) ([]store.KVEntry, error) {
	if strings.HasPrefix(scope, "settings") {
		return nil, errHostScope
	}
	return k.st.KVList(k.plugin, scope, prefix, 0)
}

func (k kv) Scopes(prefix string) ([]string, error) { return k.st.KVScopes(k.plugin, prefix) }

func (k kv) changed(scope, key string) {
	if k.emit != nil {
		k.emit(KVChangedEvent{Event: k.plugin + ".kv.changed", Scope: scope, Key: key})
	}
}

// KVParams are what KV methods take, over RPC.
type KVParams struct {
	Scope  string          `json:"scope"`
	Key    string          `json:"key"`
	Value  json.RawMessage `json:"value"`
	Prefix string          `json:"prefix"`
}

// CallKV runs one KV method by name (get, set, delete, list, scopes).
func CallKV(k KV, method string, p KVParams) (any, error) {
	switch method {
	case "get":
		v, ok, err := k.Get(p.Scope, p.Key)
		if err != nil {
			return nil, err
		}
		if !ok {
			return struct {
				Found bool `json:"found"`
			}{}, nil
		}
		return struct {
			Found bool            `json:"found"`
			Value json.RawMessage `json:"value"`
		}{true, v}, nil
	case "set":
		return Empty{}, k.Set(p.Scope, p.Key, p.Value)
	case "delete":
		return Empty{}, k.Delete(p.Scope, p.Key)
	case "list":
		return k.List(p.Scope, p.Prefix)
	case "scopes":
		return k.Scopes(p.Prefix)
	}
	return nil, errors.New("unknown kv method " + method)
}
