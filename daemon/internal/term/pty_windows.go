package term

import (
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/conner-replogle/everywhere/daemon/internal/proc"
)

// conPTY is a shell on a Windows pseudo console. The console's output only
// ends when the console is closed, which happens once the shell exits.
type conPTY struct {
	in      *os.File // keystrokes, to the console
	out     *os.File // the console's output
	process windows.Handle
	exited  chan struct{}
	code    uint32

	mu  sync.Mutex
	hpc windows.Handle // 0 once closed

	closeOnce sync.Once
}

func (t *conPTY) Read(p []byte) (int, error)  { return t.out.Read(p) }
func (t *conPTY) Write(p []byte) (int, error) { return t.in.Write(p) }

func (t *conPTY) Resize(cols, rows uint16) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.hpc == 0 {
		return nil
	}
	return windows.ResizePseudoConsole(t.hpc, windows.Coord{X: int16(cols), Y: int16(rows)})
}

func (t *conPTY) Wait() int {
	<-t.exited
	return int(t.code)
}

func (t *conPTY) Close() error {
	t.closeOnce.Do(func() {
		t.closeConsole()
		t.in.Close()
		t.out.Close()
		windows.CloseHandle(t.process)
	})
	return nil
}

func (t *conPTY) closeConsole() {
	t.mu.Lock()
	hpc := t.hpc
	t.hpc = 0
	t.mu.Unlock()
	if hpc != 0 {
		windows.ClosePseudoConsole(hpc)
	}
}

// wait records the shell's exit, then closes the console so Read ends once
// the last output is drained.
func (t *conPTY) wait() {
	_, _ = windows.WaitForSingleObject(t.process, windows.INFINITE)
	_ = windows.GetExitCodeProcess(t.process, &t.code)
	close(t.exited)
	t.closeConsole()
}

// spawn starts the user's shell in dir on a new pseudo console.
func spawn(threadID, dir string, cols, rows uint16) (tty, *proc.Group, error) {
	var inR, inW, outR, outW windows.Handle
	if err := windows.CreatePipe(&inR, &inW, nil, 0); err != nil {
		return nil, nil, err
	}
	if err := windows.CreatePipe(&outR, &outW, nil, 0); err != nil {
		windows.CloseHandle(inR)
		windows.CloseHandle(inW)
		return nil, nil, err
	}
	var hpc windows.Handle
	err := windows.CreatePseudoConsole(windows.Coord{X: int16(cols), Y: int16(rows)}, inR, outW, 0, &hpc)
	// The console keeps its own copies of its ends of the pipes.
	windows.CloseHandle(inR)
	windows.CloseHandle(outW)
	if err != nil {
		windows.CloseHandle(inW)
		windows.CloseHandle(outR)
		return nil, nil, err
	}
	t := &conPTY{
		in:     os.NewFile(uintptr(inW), "conpty-in"),
		out:    os.NewFile(uintptr(outR), "conpty-out"),
		exited: make(chan struct{}),
		hpc:    hpc,
	}
	shell := windowsShell()
	pi, err := startOnConsole(hpc, windows.ComposeCommandLine([]string{shell, "-NoLogo"}), dir, windowsEnv(shell, threadID))
	if err != nil {
		t.closeConsole()
		t.in.Close()
		t.out.Close()
		return nil, nil, err
	}
	defer windows.CloseHandle(pi.Thread)
	t.process = pi.Process
	// It was created suspended, so the job holds everything it starts.
	group, err := proc.AttachHandle(pi.Process)
	if err == nil {
		_, err = windows.ResumeThread(pi.Thread)
	}
	if err != nil {
		_ = windows.TerminateProcess(pi.Process, 1)
		windows.CloseHandle(pi.Process)
		t.closeConsole()
		t.in.Close()
		t.out.Close()
		return nil, nil, err
	}
	go t.wait()
	return t, group, nil
}

func startOnConsole(hpc windows.Handle, cmdline, dir string, env []string) (*windows.ProcessInformation, error) {
	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return nil, err
	}
	defer attrs.Delete()
	// The attribute's value is the console handle itself, not a pointer to it.
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, *(*unsafe.Pointer)(unsafe.Pointer(&hpc)), unsafe.Sizeof(hpc)); err != nil {
		return nil, err
	}
	si := windows.StartupInfoEx{ProcThreadAttributeList: attrs.List()}
	si.Cb = uint32(unsafe.Sizeof(si))
	// Empty standard handles make the shell use the console's; otherwise it
	// would inherit the daemon's own, which the service points at its log.
	si.Flags = windows.STARTF_USESTDHANDLES
	cmd, err := windows.UTF16PtrFromString(cmdline)
	if err != nil {
		return nil, err
	}
	wdir, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return nil, err
	}
	block := envBlock(env)
	var pi windows.ProcessInformation
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_SUSPENDED)
	if err := windows.CreateProcess(nil, cmd, nil, nil, false, flags, &block[0], wdir, &si.StartupInfo, &pi); err != nil {
		return nil, err
	}
	return &pi, nil
}

// envBlock encodes env for CreateProcess: sorted, NUL-separated, ending in
// an empty string.
func envBlock(env []string) []uint16 {
	env = append([]string(nil), env...)
	sort.Slice(env, func(i, j int) bool { return strings.ToUpper(env[i]) < strings.ToUpper(env[j]) })
	var b []uint16
	for _, kv := range env {
		b = append(b, utf16.Encode([]rune(kv))...)
		b = append(b, 0)
	}
	return append(b, 0)
}

// windowsShell is PowerShell 7 if it's installed, else Windows PowerShell,
// else cmd.
func windowsShell() string {
	for _, name := range []string{"pwsh.exe", "powershell.exe"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	if p := os.Getenv("ComSpec"); p != "" {
		return p
	}
	return filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe")
}

// windowsEnv is the daemon's environment for a shell, minus what describes
// the daemon itself.
func windowsEnv(shell, threadID string) []string {
	env := []string{}
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		switch strings.ToUpper(k) {
		case "TERM", "COLORTERM", "SHELL", "EVERYWHERE_SUPERVISED", "":
			continue
		}
		env = append(env, kv)
	}
	return append(env,
		"SHELL="+shell,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"EVERYWHERE_THREAD="+threadID,
	)
}
