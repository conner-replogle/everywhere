package desktop

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/conner-replogle/everywhere/daemon/internal/desktop/ipc"
	"github.com/conner-replogle/everywhere/daemon/internal/version"
)

// Windows drops input that a program sends to one running with more rights
// (UIPI), so a worker the daemon starts can't control games, launchers or
// installers running as administrator. `everywhere desktop enable` can set up
// an elevated worker for that, with one UAC prompt: a copy of
// everywhere-desktop.exe in Program Files, which only administrators can
// change, and a scheduled task that runs it as administrator on demand. (The
// copy next to the daemon won't do: anything running as the user can replace
// it, and the task would then run their program as administrator, unasked.)
//
// The daemon runs that task for each capture, and the worker connects back
// to a socket (ipc.ElevatedSocket). The copy only changes when someone
// approves it, so after an update it's out of date until `everywhere desktop
// enable` runs again; until then the daemon starts plain workers.

// ElevatedTask is the scheduled task that starts an elevated worker.
const ElevatedTask = "everywhere-desktop"

// elevatedStart bounds how long Task Scheduler takes to start the worker.
const elevatedStart = 10 * time.Second

func elevatedDir() string {
	pf := os.Getenv("ProgramFiles")
	if pf == "" {
		pf = `C:\Program Files`
	}
	return filepath.Join(pf, "everywhere")
}

func elevatedExe() string { return filepath.Join(elevatedDir(), HelperName) }

// launchWorker starts the elevated worker when elevate is set and it's usable,
// else a plain one.
func launchWorker(exe string, cfgJSON []byte, env []string, elevate bool) (workerProcess, io.WriteCloser, io.ReadCloser, error) {
	if elevate && elevatedUsable() {
		proc, stdin, stdout, err := launchElevated(cfgJSON)
		if err == nil {
			return proc, stdin, stdout, nil
		}
		elevatedFailed()
		slog.Warn("the elevated desktop worker didn't start; input won't reach programs running as administrator", "err", err)
	}
	return launchChild(exe, cfgJSON, env)
}

// elevatedState caches whether the elevated worker is usable, until its
// binary changes.
var elevatedState struct {
	sync.Mutex
	size    int64
	mod     time.Time
	checked bool
	usable  bool
	why     string // when not usable
}

// elevatedUsable reports whether the elevated worker is installed and is this
// release's.
func elevatedUsable() bool {
	ok, why := elevatedCheck()
	if !ok && why != "" {
		slog.Debug("not using the elevated desktop worker", "why", why)
	}
	return ok
}

func elevatedCheck() (bool, string) {
	s := &elevatedState
	s.Lock()
	defer s.Unlock()
	st, err := os.Stat(elevatedExe())
	if err != nil {
		s.checked = false
		return false, ""
	}
	if s.checked && st.Size() == s.size && st.ModTime().Equal(s.mod) {
		return s.usable, s.why
	}
	s.checked, s.size, s.mod = true, st.Size(), st.ModTime()
	s.usable, s.why = false, ""
	switch out, err := hiddenCommand(elevatedExe(), "version").Output(); {
	case err != nil:
		s.why = fmt.Sprintf("%s doesn't run: %v", elevatedExe(), err)
	case strings.TrimSpace(string(out)) != version.Version:
		s.why = fmt.Sprintf("it's from %s, not %s; run `everywhere desktop enable` to update it", strings.TrimSpace(string(out)), version.Version)
	case !taskInstalled():
		s.why = fmt.Sprintf("the %s scheduled task is missing; run `everywhere desktop enable` to set it up", ElevatedTask)
	default:
		s.usable = true
	}
	return s.usable, s.why
}

// elevatedFailed stops using the elevated worker until its binary changes, so
// each capture doesn't wait for one that won't come.
func elevatedFailed() {
	s := &elevatedState
	s.Lock()
	defer s.Unlock()
	if s.checked {
		s.usable, s.why = false, "it didn't start last time"
	}
}

func taskInstalled() bool {
	return hiddenCommand("schtasks", "/Query", "/TN", ElevatedTask).Run() == nil
}

func hiddenCommand(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd
}

// launchMu makes starts take turns: each listens on the one socket.
var launchMu sync.Mutex

// launchElevated runs the task and hands the worker that connects its config.
func launchElevated(cfgJSON []byte) (workerProcess, io.WriteCloser, io.ReadCloser, error) {
	launchMu.Lock()
	defer launchMu.Unlock()
	sock := ipc.ElevatedSocket()
	if err := os.MkdirAll(filepath.Dir(sock), 0o755); err != nil {
		return nil, nil, nil, err
	}
	_ = os.Remove(sock)
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		return nil, nil, nil, err
	}
	defer os.Remove(sock)
	defer ln.Close()
	if out, err := hiddenCommand("schtasks", "/Run", "/TN", ElevatedTask).CombinedOutput(); err != nil {
		return nil, nil, nil, fmt.Errorf("schtasks /Run: %w: %s", err, strings.TrimSpace(string(out)))
	}
	_ = ln.SetDeadline(time.Now().Add(elevatedStart))
	c, err := ln.AcceptUnix()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("it didn't connect: %w", err)
	}
	if err := ipc.WriteConfig(c, cfgJSON); err != nil {
		c.Close()
		return nil, nil, nil, err
	}
	p := &connProcess{c: c, done: make(chan struct{})}
	return p, connWriter{p}, connReader{p}, nil
}

// ElevatedInstalled reports whether an elevated worker was set up, current or not.
func ElevatedInstalled() bool {
	_, err := os.Stat(elevatedExe())
	return err == nil
}

// ElevatedStatus describes the elevated worker, for `everywhere desktop status`.
func ElevatedStatus() string {
	if _, err := os.Stat(elevatedExe()); err != nil {
		return "off: input won't reach programs running as administrator (`everywhere desktop enable` sets it up)"
	}
	if ok, why := elevatedCheck(); !ok {
		return "not in use: " + why
	}
	return "on (" + elevatedExe() + ")"
}

// SetupElevated sets up the elevated worker from the one next to daemonExe,
// asking for administrator rights (UAC) unless this process has them.
// ErrDeclined means nobody approved.
func SetupElevated(daemonExe string) error {
	u, err := user.Current()
	if err != nil {
		return err
	}
	src := filepath.Join(filepath.Dir(daemonExe), HelperName)
	if windows.GetCurrentProcessToken().IsElevated() {
		return InstallElevated(src, u.Username)
	}
	// The account is passed on: an administrator approving for a standard
	// user runs the elevated half as themselves.
	return runElevated(daemonExe, "desktop", ElevateArg, u.Username, src)
}

// RemoveElevated removes the elevated worker and its task, asking for
// administrator rights (UAC) unless this process has them.
func RemoveElevated(daemonExe string) error {
	if _, err := os.Stat(elevatedExe()); err != nil && !taskInstalled() {
		return nil
	}
	if windows.GetCurrentProcessToken().IsElevated() {
		return UninstallElevated()
	}
	return runElevated(daemonExe, "desktop", ElevateArg, "--remove")
}

// ElevateArg is the `everywhere desktop` subcommand that SetupElevated and
// RemoveElevated run as administrator.
const ElevateArg = "elevate"

// ElevateMain is `everywhere desktop elevate <account> <worker>` (or
// `--remove`), run as administrator. Nobody sees its console, so a failure
// shows a message box.
func ElevateMain(args []string) error {
	var err error
	switch {
	case len(args) == 1 && args[0] == "--remove":
		err = UninstallElevated()
	case len(args) == 2:
		err = InstallElevated(args[1], args[0])
	default:
		err = errors.New("usage: everywhere desktop elevate <account> <everywhere-desktop.exe> | --remove")
	}
	if err != nil {
		text, _ := windows.UTF16PtrFromString(err.Error())
		title, _ := windows.UTF16PtrFromString("everywhere remote desktop")
		_, _ = windows.MessageBox(0, text, title, windows.MB_OK|windows.MB_ICONERROR)
	}
	return err
}

// InstallElevated copies the worker at src into Program Files and registers
// the task that runs it as administrator for account. It needs administrator
// rights.
func InstallElevated(src, account string) error {
	if err := os.MkdirAll(elevatedDir(), 0o755); err != nil {
		return err
	}
	if err := copyWorker(src, elevatedExe()); err != nil {
		return fmt.Errorf("copying %s: %w", HelperName, err)
	}
	// The task's XML goes where only administrators can write, so nothing
	// can swap it before schtasks reads it.
	xml := filepath.Join(elevatedDir(), "task.xml")
	if err := os.WriteFile(xml, utf16File(elevatedTaskXML(elevatedExe(), account)), 0o644); err != nil {
		return err
	}
	defer os.Remove(xml)
	if out, err := hiddenCommand("schtasks", "/Create", "/TN", ElevatedTask, "/XML", xml, "/F").CombinedOutput(); err != nil {
		return fmt.Errorf("schtasks /Create: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// UninstallElevated removes the task and the copy. It needs administrator
// rights.
func UninstallElevated() error {
	if taskInstalled() {
		if out, err := hiddenCommand("schtasks", "/Delete", "/TN", ElevatedTask, "/F").CombinedOutput(); err != nil {
			return fmt.Errorf("schtasks /Delete: %w: %s", err, strings.TrimSpace(string(out)))
		}
	}
	if err := os.RemoveAll(elevatedDir()); err != nil {
		return fmt.Errorf("removing %s: %w (a worker may still be running; try again after the session ends)", elevatedDir(), err)
	}
	return nil
}

// copyWorker replaces dst with src. A running worker's binary can't be
// overwritten, but it can be renamed out of the way.
func copyWorker(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	old := dst + ".old"
	_ = os.Remove(old)
	if err := os.Rename(dst, old); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.WriteFile(dst, b, 0o755); err != nil {
		_ = os.Rename(old, dst)
		return err
	}
	_ = os.Remove(old) // fails while the old one runs; the next install retries
	return nil
}

// elevatedTaskXML is a task that runs exe as administrator in account's
// session when asked (schtasks /Run), any number at once, without a window.
func elevatedTaskXML(exe, account string) string {
	conhost := filepath.Join(os.Getenv("SystemRoot"), "System32", "conhost.exe")
	if os.Getenv("SystemRoot") == "" {
		conhost = `C:\Windows\System32\conhost.exe`
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>everywhere remote desktop worker, elevated so its input reaches programs running as administrator</Description>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>%[1]s</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>%[2]s</Command>
      <Arguments>--headless "%[3]s" %[4]s</Arguments>
    </Exec>
  </Actions>
</Task>
`, xmlEscape(account), xmlEscape(conhost), xmlEscape(exe), ipc.ElevatedArg)
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

// utf16File encodes s as UTF-16LE with a byte order mark, which is what
// schtasks expects of a task's XML.
func utf16File(s string) []byte {
	u := utf16.Encode([]rune(s))
	b := make([]byte, 2, 2+2*len(u))
	b[0], b[1] = 0xFF, 0xFE
	for _, c := range u {
		b = append(b, byte(c), byte(c>>8))
	}
	return b
}

// ErrDeclined is returned when the UAC prompt was declined.
var ErrDeclined = errors.New("administrator rights weren't granted")

var procShellExecuteEx = windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteExW")

// shellExecuteInfo is SHELLEXECUTEINFOW.
type shellExecuteInfo struct {
	size          uint32
	mask          uint32
	hwnd          windows.Handle
	verb          *uint16
	file          *uint16
	params        *uint16
	dir           *uint16
	show          int32
	instApp       windows.Handle
	idList        uintptr
	class         *uint16
	keyClass      windows.Handle
	hotKey        uint32
	iconOrMonitor windows.Handle
	process       windows.Handle
}

const (
	seeMaskNoCloseProcess = 0x40
	seeMaskNoAsync        = 0x100
)

// runElevated runs exe with args as administrator (the UAC prompt) and waits
// for it.
func runElevated(exe string, args ...string) error {
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = syscall.EscapeArg(a)
	}
	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(exe)
	params, _ := windows.UTF16PtrFromString(strings.Join(quoted, " "))
	info := shellExecuteInfo{mask: seeMaskNoCloseProcess | seeMaskNoAsync, verb: verb, file: file, params: params, show: windows.SW_HIDE}
	info.size = uint32(unsafe.Sizeof(info))
	if ok, _, err := procShellExecuteEx.Call(uintptr(unsafe.Pointer(&info))); ok == 0 {
		if errors.Is(err, windows.ERROR_CANCELLED) {
			return ErrDeclined
		}
		return fmt.Errorf("ShellExecuteEx: %w", err)
	}
	if info.process == 0 {
		return errors.New("the elevated process didn't start")
	}
	defer windows.CloseHandle(info.process)
	if _, err := windows.WaitForSingleObject(info.process, windows.INFINITE); err != nil {
		return err
	}
	var code uint32
	if err := windows.GetExitCodeProcess(info.process, &code); err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("the elevated setup failed (exit status %d)", code)
	}
	return nil
}
