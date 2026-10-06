//go:build !windows

package term

import (
	"bufio"
	"errors"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"

	"github.com/creack/pty"

	"github.com/conner-replogle/everywhere/daemon/internal/proc"
)

// unixTTY is a shell on a PTY.
type unixTTY struct {
	*os.File // the PTY's master side
	cmd      *exec.Cmd
}

func (t *unixTTY) Resize(cols, rows uint16) error {
	return pty.Setsize(t.File, &pty.Winsize{Cols: cols, Rows: rows})
}

func (t *unixTTY) Wait() int {
	err := t.cmd.Wait()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &exit):
		return exit.ExitCode()
	default:
		return -1
	}
}

// Spawn starts the user's login shell in c.Dir on a new PTY, running
// c.Command if it's set (as `shell -l -c command`).
func Spawn(c Command) (TTY, *proc.Group, error) {
	shell := loginShell()
	cmd := exec.Command(shell)
	if c.Command == "" {
		cmd.Args = []string{"-" + filepath.Base(shell)} // login shell
	} else {
		cmd.Args = []string{filepath.Base(shell), "-l", "-c", c.Command}
	}
	cmd.Dir = c.Dir
	cmd.Env = shellEnv(shell, c.Env)
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: c.Cols, Rows: c.Rows})
	if err != nil {
		return nil, nil, err
	}
	// The PTY made the shell a session leader, so its process group is the Group.
	group, err := proc.Attach(cmd)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = ptmx.Close()
		_ = cmd.Wait()
		return nil, nil, err
	}
	return &unixTTY{File: ptmx, cmd: cmd}, group, nil
}

// loginShell returns the current user's shell from /etc/passwd, then $SHELL,
// then /bin/sh.
func loginShell() string {
	if u, err := user.Current(); err == nil {
		if f, err := os.Open("/etc/passwd"); err == nil {
			defer f.Close()
			sc := bufio.NewScanner(f)
			for sc.Scan() {
				fields := strings.Split(sc.Text(), ":")
				if len(fields) >= 7 && fields[0] == u.Username && fields[6] != "" {
					if _, err := os.Stat(fields[6]); err == nil {
						return fields[6]
					}
				}
			}
		}
	}
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	return "/bin/sh"
}

// Environment variables from the daemon's service manager that shouldn't leak
// into user shells.
var dropEnv = map[string]bool{
	"INVOCATION_ID": true, "JOURNAL_STREAM": true, "NOTIFY_SOCKET": true,
	"MANAGERPID": true, "SYSTEMD_EXEC_PID": true, "LISTEN_FDS": true, "LISTEN_PID": true,
}

func shellEnv(shell string, extra []string) []string {
	env := []string{}
	have := map[string]bool{}
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if dropEnv[k] || k == "TERM" || k == "COLORTERM" || k == "SHELL" {
			continue
		}
		have[k] = true
		env = append(env, kv)
	}
	if u, err := user.Current(); err == nil {
		for k, v := range map[string]string{"HOME": u.HomeDir, "USER": u.Username, "LOGNAME": u.Username} {
			if !have[k] {
				env = append(env, k+"="+v)
			}
		}
	}
	if !have["PATH"] {
		env = append(env, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	}
	if !have["LANG"] {
		env = append(env, "LANG=C.UTF-8")
	}
	env = append(env,
		"SHELL="+shell,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	)
	return append(env, extra...)
}
