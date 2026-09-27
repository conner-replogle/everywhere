package proc

import (
	"bufio"
	"io"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// The test binary doubles as the processes in the group: a child that starts
// a grandchild, and a grandchild that sleeps. Both hold the stdout pipe open,
// so it only reaches EOF once both are gone.
func TestMain(m *testing.M) {
	switch os.Getenv("PROC_TEST_ROLE") {
	case "child":
		// Wait until the parent has the group, so the grandchild is in it.
		bufio.NewReader(os.Stdin).ReadString('\n')
		gc := exec.Command(self())
		gc.Env = append(os.Environ(), "PROC_TEST_ROLE=grandchild")
		gc.Stdout = os.Stdout
		if err := gc.Start(); err != nil {
			os.Exit(2)
		}
		time.Sleep(time.Minute)
		os.Exit(0)
	case "grandchild":
		os.Stdout.WriteString("ready\n")
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func self() string {
	exe, err := os.Executable()
	if err != nil {
		panic(err)
	}
	return exe
}

func TestSignalEndsTree(t *testing.T) {
	cmd := exec.Command(self())
	cmd.Env = append(os.Environ(), "PROC_TEST_ROLE=child")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	g, err := Start(cmd)
	if err != nil {
		t.Fatal(err)
	}
	defer g.Release()
	io.WriteString(stdin, "go\n")

	out := bufio.NewReader(stdout)
	if line, err := out.ReadString('\n'); err != nil || line != "ready\n" {
		t.Fatalf("grandchild didn't start: %q, %v", line, err)
	}
	if err := g.Signal(syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	eof := make(chan struct{})
	go func() {
		io.Copy(io.Discard, out)
		close(eof)
	}()
	select {
	case <-eof:
	case <-time.After(10 * time.Second):
		t.Fatal("the grandchild outlived the group")
	}
	cmd.Wait()
}
