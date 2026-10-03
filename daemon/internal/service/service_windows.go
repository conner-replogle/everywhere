// On Windows the daemon is a per-user scheduled task that starts at logon in
// the user's session, so it has their credentials (Git Credential Manager,
// DPAPI) and needs no admin rights. The task runs `everywhere service run`
// under a headless console, so no window opens. That process supervises the
// daemon: Windows has no exec, and Task Scheduler neither restarts a crashed
// program nor ends the processes a task started.
package service

import (
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

const taskName = "everywhere"

// ExitRevoked is the daemon's exit status when its device was removed; the
// supervisor doesn't restart on it.
const ExitRevoked = 3

// ExitRestart is the daemon's exit status when it wants to be started again
// from the binary on disk, e.g. after an update.
const ExitRestart = 75

// SupervisedEnv is set in the daemon's environment when the service runs it.
const SupervisedEnv = "EVERYWHERE_SUPERVISED"

const (
	restartDelay = 5 * time.Second
	maxLogBytes  = 10 << 20
)

func stateDir() string {
	if d := os.Getenv("LOCALAPPDATA"); d != "" {
		return filepath.Join(d, "everywhere")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "AppData", "Local", "everywhere")
}

// LogPath is where the service writes the daemon's output.
func LogPath() string { return filepath.Join(stateDir(), "everywhere.log") }

func pidPath() string { return filepath.Join(stateDir(), "service.pid") }

func schtasks(args ...string) *exec.Cmd {
	cmd := exec.Command("schtasks", args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

func taskXML(bin, account string) string {
	conhost := filepath.Join(os.Getenv("SystemRoot"), "System32", "conhost.exe")
	if os.Getenv("SystemRoot") == "" {
		conhost = `C:\Windows\System32\conhost.exe`
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>everywhere daemon</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>%[1]s</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>%[1]s</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>%[2]s</Command>
      <Arguments>--headless "%[3]s" service run</Arguments>
    </Exec>
  </Actions>
</Task>
`, xmlEscape(account), xmlEscape(conhost), xmlEscape(bin))
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

// Install registers the task for the binary at bin and (re)starts it.
func Install(bin string) error {
	u, err := user.Current()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(stateDir(), 0o755); err != nil {
		return err
	}
	xml := filepath.Join(stateDir(), "task.xml")
	if err := os.WriteFile(xml, utf16File(taskXML(bin, u.Username)), 0o644); err != nil {
		return err
	}
	defer os.Remove(xml)
	stop()
	out, err := exec.Command("schtasks", "/Create", "/TN", taskName, "/XML", xml, "/F").CombinedOutput()
	if err != nil {
		return fmt.Errorf("schtasks /Create: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return start()
}

// Restart restarts the service if it is installed.
func Restart() error {
	if !Installed() {
		return nil
	}
	stop()
	return start()
}

func start() error {
	if out, err := exec.Command("schtasks", "/Run", "/TN", taskName).CombinedOutput(); err != nil {
		return fmt.Errorf("schtasks /Run: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// stop ends the task's console and the supervisor, whose job object takes
// the daemon and everything it started down with it.
func stop() {
	_ = exec.Command("schtasks", "/End", "/TN", taskName).Run()
	if p, ok := supervisor(); ok {
		_ = windows.TerminateProcess(p, 1)
		_, _ = windows.WaitForSingleObject(p, 5000)
		windows.CloseHandle(p)
	}
	os.Remove(pidPath())
}

func Installed() bool {
	return exec.Command("schtasks", "/Query", "/TN", taskName).Run() == nil
}

// Uninstall stops the service and removes the task.
func Uninstall() error {
	if !Installed() {
		return nil
	}
	stop()
	return schtasks("/Delete", "/TN", taskName, "/F").Run()
}

// Status reports whether the supervisor is running.
func Status() string {
	if !Installed() {
		return "not installed"
	}
	if p, ok := supervisor(); ok {
		windows.CloseHandle(p)
		return "running"
	}
	return "stopped"
}

// The pid file holds the supervisor's PID and creation time, so a reused PID
// is never mistaken for it.
func processStart(p windows.Handle) (int64, error) {
	var created, exited, kernel, usr windows.Filetime
	if err := windows.GetProcessTimes(p, &created, &exited, &kernel, &usr); err != nil {
		return 0, err
	}
	return created.Nanoseconds(), nil
}

// supervisor opens the running supervisor's process.
func supervisor() (windows.Handle, bool) {
	raw, err := os.ReadFile(pidPath())
	if err != nil {
		return 0, false
	}
	fields := strings.Fields(string(raw))
	if len(fields) != 2 {
		return 0, false
	}
	pid, err1 := strconv.ParseUint(fields[0], 10, 32)
	started, err2 := strconv.ParseInt(fields[1], 10, 64)
	if err1 != nil || err2 != nil {
		return 0, false
	}
	p, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return 0, false
	}
	var code uint32
	if t, err := processStart(p); err != nil || t != started || windows.GetExitCodeProcess(p, &code) != nil || code != 259 /* STILL_ACTIVE */ {
		windows.CloseHandle(p)
		return 0, false
	}
	return p, true
}

func writePID() error {
	self := windows.CurrentProcess()
	started, err := processStart(self)
	if err != nil {
		return err
	}
	return os.WriteFile(pidPath(), fmt.Appendf(nil, "%d %d\n", os.Getpid(), started), 0o644)
}

// openLog appends to the log, starting a new one when it has grown too big.
func openLog() (*os.File, error) {
	if info, err := os.Stat(LogPath()); err == nil && info.Size() > maxLogBytes {
		_ = os.Rename(LogPath(), LogPath()+".1")
	}
	return os.OpenFile(LogPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
}

// killOnCloseJob is a job object whose processes all end when it's closed.
func killOnCloseJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

// Run supervises the daemon at bin until it exits cleanly or its device is
// revoked, restarting it when it crashes or asks to be restarted. It's what
// the scheduled task runs.
func Run(bin string) error {
	if err := os.MkdirAll(stateDir(), 0o755); err != nil {
		return err
	}
	if p, ok := supervisor(); ok {
		windows.CloseHandle(p)
		return errors.New("the service is already running")
	}
	if err := writePID(); err != nil {
		return err
	}
	defer os.Remove(pidPath())
	logf, err := openLog()
	if err != nil {
		return err
	}
	defer logf.Close()
	logger := log.New(logf, "service: ", log.LstdFlags)
	for {
		code, err := runOnce(bin, logf)
		switch {
		case err != nil:
			logger.Printf("starting the daemon: %v", err)
		case code == ExitRestart:
			logger.Printf("daemon asked to restart")
			continue
		case code == ExitRevoked:
			logger.Printf("device was removed; stopping")
			return nil
		case code == 0:
			logger.Printf("daemon stopped")
			return nil
		default:
			logger.Printf("daemon exited with status %d", code)
		}
		time.Sleep(restartDelay)
	}
}

// runOnce runs the daemon to completion inside a job object, so anything it
// leaves behind ends with it, as under systemd.
func runOnce(bin string, out io.Writer) (int, error) {
	job, err := killOnCloseJob()
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(job)
	cmd := exec.Command(bin, "daemon")
	cmd.Stdout, cmd.Stderr = out, out
	cmd.Env = append(os.Environ(), SupervisedEnv+"=1")
	// Suspended until it's in the job, so nothing it starts escapes.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_SUSPENDED}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	if err := assignAndResume(job, cmd.Process.Pid); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return 0, err
	}
	err = cmd.Wait()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), nil
	}
	return 0, err
}

func assignAndResume(job windows.Handle, pid int) error {
	p, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(p)
	if err := windows.AssignProcessToJobObject(job, p); err != nil {
		return err
	}
	return resumeThreads(uint32(pid))
}

// resumeThreads resumes a process started with CREATE_SUSPENDED; exec.Cmd
// doesn't expose its main thread handle.
func resumeThreads(pid uint32) error {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snap)
	var te windows.ThreadEntry32
	te.Size = uint32(unsafe.Sizeof(te))
	for err = windows.Thread32First(snap, &te); err == nil; err = windows.Thread32Next(snap, &te) {
		if te.OwnerProcessID != pid {
			continue
		}
		t, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, te.ThreadID)
		if err != nil {
			return err
		}
		_, err = windows.ResumeThread(t)
		windows.CloseHandle(t)
		if err != nil {
			return err
		}
	}
	return nil
}
