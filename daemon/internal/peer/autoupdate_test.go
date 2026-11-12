//go:build !windows

package peer

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// What holds an update when idle: someone using a thread lately, and a
// command running in a terminal (not a shell at its prompt).
func TestRestartHolds(t *testing.T) {
	s := testServer(t)
	later := time.Now().Add(time.Hour) // past any recent use
	if h := s.restartHolds(time.Now()); len(h) != 0 {
		t.Fatalf("a new daemon holds: %v", h)
	}
	projects, _ := s.store.ListProjects()
	th, err := s.store.CreateThread(projects[0].ID, "", protocol.ThreadTerminal)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.store.TouchThread(th.ID); err != nil {
		t.Fatal(err)
	}
	if h := s.restartHolds(time.Now()); len(h) != 1 || !strings.Contains(h[0], "used in the last") {
		t.Errorf("recent use = %v", h)
	}
	if h := s.restartHolds(later); len(h) != 0 {
		t.Errorf("an hour later = %v", h)
	}

	svc, _ := s.plugins.Service(plugin.ServiceTerminal)
	terms := svc.(plugin.TerminalService)
	running := func(want bool) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for {
			got := slices.ContainsFunc(s.restartHolds(later), func(h string) bool { return strings.Contains(h, "terminal") })
			if got == want {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("terminal hold = %v, want %v (%v)", got, want, s.restartHolds(later))
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	if err := terms.Type(th.ID, nil, 80, 24); err != nil {
		t.Fatal(err)
	}
	running(false) // a shell at its prompt doesn't hold
	if err := terms.Type(th.ID, []byte("sleep 2\n"), 80, 24); err != nil {
		t.Fatal(err)
	}
	running(true)
	running(false)
}
