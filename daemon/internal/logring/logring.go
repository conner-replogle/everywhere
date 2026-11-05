// Package logring keeps the daemon's most recent log lines in memory, so a
// bug report from the app can include them (debug.logs).
package logring

import (
	"bytes"
	"sync"
)

// Ring is an io.Writer that keeps the last Max lines written to it.
type Ring struct {
	Max int

	mu      sync.Mutex
	lines   []string
	next    int
	partial []byte
}

// Default is the daemon's log, as main tees slog's output into it.
var Default = &Ring{Max: 2000}

// Write takes log output; lines are split on newlines.
func (r *Ring) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	buf := append(r.partial, p...)
	for {
		i := bytes.IndexByte(buf, '\n')
		if i < 0 {
			break
		}
		r.add(string(buf[:i]))
		buf = buf[i+1:]
	}
	r.partial = append([]byte(nil), buf...)
	return len(p), nil
}

func (r *Ring) add(line string) {
	if len(r.lines) < r.Max {
		r.lines = append(r.lines, line)
		return
	}
	r.lines[r.next] = line
	r.next = (r.next + 1) % r.Max
}

// Tail returns up to n of the newest lines, oldest first (all of them if n <= 0).
func (r *Ring) Tail(n int) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	all := append(append([]string{}, r.lines[r.next:]...), r.lines[:r.next]...)
	if n > 0 && n < len(all) {
		all = all[len(all)-n:]
	}
	return all
}
