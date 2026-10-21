package plugin

import (
	"encoding/json"
	"log/slog"
	"sync"
)

// Topic names an event on the bus and its payload's type.
type Topic[T any] struct{ Name string }

// Bus carries events between plugins inside the daemon, so they react to
// each other without importing each other. Handlers run synchronously, in
// the order they subscribed; a slow one should hand off to a goroutine.
type Bus struct {
	mu   sync.RWMutex
	subs map[string][]func(any)
	// raw handlers get every event as JSON (external plugins).
	raw []func(topic string, payload json.RawMessage)
}

// NewBus makes an empty bus.
func NewBus() *Bus { return &Bus{subs: map[string][]func(any){}} }

// Subscribe calls fn with each event published on t.
func Subscribe[T any](b *Bus, t Topic[T], fn func(T)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.subs[t.Name] = append(b.subs[t.Name], func(v any) { fn(v.(T)) })
}

// SubscribeRaw calls fn with every event, as JSON.
func (b *Bus) SubscribeRaw(fn func(topic string, payload json.RawMessage)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.raw = append(b.raw, fn)
}

// Publish sends v to t's subscribers.
func Publish[T any](b *Bus, t Topic[T], v T) {
	b.mu.RLock()
	subs := b.subs[t.Name]
	raw := b.raw
	b.mu.RUnlock()
	for _, fn := range subs {
		call(t.Name, func() { fn(v) })
	}
	if len(raw) > 0 {
		payload, err := json.Marshal(v)
		if err != nil {
			return
		}
		for _, fn := range raw {
			call(t.Name, func() { fn(t.Name, payload) })
		}
	}
}

// call runs one handler; a panic in a plugin's handler doesn't take the
// publisher down.
func call(topic string, fn func()) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("bus handler panicked", "topic", topic, "panic", r)
		}
	}()
	fn()
}
