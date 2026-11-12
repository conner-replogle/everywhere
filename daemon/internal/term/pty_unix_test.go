//go:build !windows

package term

import (
	"io"
	"testing"
	"time"
)

// A shell at its prompt has the terminal; a command it runs takes it.
func TestRunningCommand(t *testing.T) {
	tty, _, err := Spawn(Command{Dir: t.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	defer tty.Close()
	go io.Copy(io.Discard, tty)
	f := tty.(interface{ RunningCommand() (bool, error) })
	wait := func(want bool) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for {
			busy, err := f.RunningCommand()
			if err != nil {
				t.Fatal(err)
			}
			if busy == want {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("busy = %v, want %v", busy, want)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	wait(false) // at the prompt
	if _, err := tty.Write([]byte("sleep 2\n")); err != nil {
		t.Fatal(err)
	}
	wait(true)
	wait(false) // back at the prompt
}
