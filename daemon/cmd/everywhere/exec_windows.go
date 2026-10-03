package main

import (
	"errors"
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"

	"github.com/conner-replogle/everywhere/daemon/internal/service"
)

// reexec starts the binary on disk in this process's place. Windows has no
// exec: under the service the supervisor starts it again; otherwise it runs
// as a child that this process waits on.
func reexec() error {
	if os.Getenv(service.SupervisedEnv) != "" {
		os.Exit(service.ExitRestart)
	}
	exe, err := executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	err = cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		os.Exit(exit.ExitCode())
	}
	return err
}

// removeSelf deletes the running binary, which Windows won't do while it
// runs, so a detached cmd deletes it a moment after this process exits.
func removeSelf(exe string) error {
	cmd := exec.Command("cmd.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine:       `cmd.exe /d /c ping -n 3 127.0.0.1 >nul & del /f /q "` + exe + `"`,
		CreationFlags: windows.CREATE_NO_WINDOW | windows.DETACHED_PROCESS,
	}
	return cmd.Start()
}
