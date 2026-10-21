// Command notes is an example everywhere plugin: a Notes tab in any
// thread, which the thread's claude can read and add to with the notes_read
// and notes_append tools. Notes are kept in the plugin's key/value state,
// one per thread, so they go when the thread does. The sidebar lists the
// threads that have notes, and their rows get a badge.
//
// Install it on a device (it builds there):
//
//	go build -o notes . && everywhere plugin install .
package main

import (
	"context"
	"log"
	"sort"
	"strings"
	"sync"

	"github.com/conner-replogle/everywhere/daemon/sdk/plugin"
)

var mu sync.Mutex

func main() {
	p := plugin.New()
	kv := p.KV()
	scope := func(threadID string) string { return "thread:" + threadID }
	read := func(threadID string) (string, error) {
		var text string
		_, err := kv.Get(scope(threadID), "text", &text)
		return text, err
	}
	write := func(threadID, text string) error {
		if strings.TrimSpace(text) == "" {
			return kv.Delete(scope(threadID), "text")
		}
		return kv.Set(scope(threadID), "text", text)
	}
	threadArg := func(c plugin.Call) string {
		var a struct {
			ThreadID string `json:"threadId"`
		}
		_ = c.Decode(&a)
		return a.ThreadID
	}

	p.Method("notes.get", func(_ context.Context, c plugin.Call) (any, error) {
		text, err := read(threadArg(c))
		return map[string]string{"text": text}, err
	})
	p.Method("notes.set", func(_ context.Context, c plugin.Call) (any, error) {
		var a struct {
			ThreadID string `json:"threadId"`
			Text     string `json:"text"`
		}
		if err := c.Decode(&a); err != nil {
			return nil, err
		}
		mu.Lock()
		defer mu.Unlock()
		return struct{}{}, write(a.ThreadID, a.Text)
	})
	p.Method("notes.clear", func(_ context.Context, c plugin.Call) (any, error) {
		return struct{}{}, write(threadArg(c), "")
	})

	// The sidebar's Notes section: threads that have notes, newest first.
	p.Method("notes.sidebar", func(context.Context, plugin.Call) (any, error) {
		var show bool
		if !p.Setting("sidebar", &show) || !show {
			return map[string]any{"title": "Notes", "rows": []any{}}, nil
		}
		scopes, err := kv.Scopes("thread:")
		if err != nil {
			return nil, err
		}
		type row struct {
			Label    string `json:"label"`
			Detail   string `json:"detail,omitempty"`
			ThreadID string `json:"threadId"`
		}
		rows := []row{}
		for _, sc := range scopes {
			id := strings.TrimPrefix(sc, "thread:")
			text, err := read(id)
			if err != nil || text == "" {
				continue
			}
			var t struct {
				Name string `json:"name"`
			}
			if p.Thread(id, &t) != nil {
				continue
			}
			first, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
			rows = append(rows, row{Label: t.Name, Detail: first, ThreadID: id})
		}
		sort.Slice(rows, func(i, j int) bool { return rows[i].Label < rows[j].Label })
		var title string
		p.Setting("title", &title)
		return map[string]any{"title": title, "rows": rows}, nil
	})
	p.Method("notes.badges", func(context.Context, plugin.Call) (any, error) {
		scopes, err := kv.Scopes("thread:")
		if err != nil {
			return nil, err
		}
		out := map[string]any{}
		for _, sc := range scopes {
			out[strings.TrimPrefix(sc, "thread:")] = map[string]string{"text": "notes"}
		}
		return out, nil
	})
	p.Method("notes.header", func(_ context.Context, c plugin.Call) (any, error) {
		text, _ := read(threadArg(c))
		if text == "" {
			return []any{}, nil
		}
		return []map[string]any{{"label": "Clear notes", "icon": "trash", "call": "notes.clear"}}, nil
	})

	p.Tool("read", func(_ context.Context, c plugin.ToolCall) (string, error) {
		text, err := read(c.ThreadID)
		if err != nil || strings.TrimSpace(text) == "" {
			return "This thread has no notes yet.", err
		}
		return text, nil
	})
	p.Tool("append", func(_ context.Context, c plugin.ToolCall) (string, error) {
		var a struct {
			Text string `json:"text"`
		}
		if err := c.Decode(&a); err != nil {
			return "", err
		}
		mu.Lock()
		defer mu.Unlock()
		text, err := read(c.ThreadID)
		if err != nil {
			return "", err
		}
		if text != "" && !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		if err := write(c.ThreadID, text+a.Text+"\n"); err != nil {
			return "", err
		}
		return "Added to the thread's notes.", nil
	})
	if err := p.Run(); err != nil {
		log.Fatal(err)
	}
}
