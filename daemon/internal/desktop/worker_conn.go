//go:build darwin || windows

package desktop

import (
	"net"
	"sync"
)

// connProcess is a worker by its connection (the macOS app, or an elevated
// Windows worker): it exits when the connection closes, and the connection
// closes when it exits.
type connProcess struct {
	c    *net.UnixConn
	once sync.Once
	done chan struct{}
}

func (p *connProcess) close() {
	p.once.Do(func() {
		p.c.Close()
		close(p.done)
	})
}

func (p *connProcess) Wait() error { <-p.done; return nil }
func (p *connProcess) Kill() error { p.close(); return nil }

type connReader struct{ p *connProcess }

func (r connReader) Read(b []byte) (int, error) {
	n, err := r.p.c.Read(b)
	if err != nil {
		r.p.close()
	}
	return n, err
}

func (r connReader) Close() error { r.p.close(); return nil }

type connWriter struct{ p *connProcess }

func (w connWriter) Write(b []byte) (int, error) { return w.p.c.Write(b) }

// Close ends the commands; the app quits once it has read them.
func (w connWriter) Close() error { return w.p.c.CloseWrite() }
