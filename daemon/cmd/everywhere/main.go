// Command everywhere is the device daemon and its CLI.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/config"
	"github.com/conner-replogle/everywhere/daemon/internal/hub"
	"github.com/conner-replogle/everywhere/daemon/internal/ice"
	"github.com/conner-replogle/everywhere/daemon/internal/peer"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/service"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
	"github.com/conner-replogle/everywhere/daemon/internal/update"
	"github.com/conner-replogle/everywhere/daemon/internal/version"
)

const usage = `everywhere — run terminals on this machine from anywhere

Usage:
  everywhere enroll --server URL --token TOKEN   enroll this device (done by the installer)
  everywhere daemon [--server URL]               run the daemon (systemd runs this)
  everywhere add [PATH] [--name NAME]            add a project (default: current directory)
  everywhere status                              show enrollment and service status
  everywhere service install|uninstall           manage the systemd unit
  everywhere update                              install the latest release
  everywhere desktop enable|disable|status       allow remote desktop of this machine's screen
  everywhere uninstall [--purge]                 remove the service and binary (--purge: config and data too)
  everywhere version
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch cmd, args := os.Args[1], os.Args[2:]; cmd {
	case "enroll":
		err = enroll(args)
	case "daemon":
		err = daemon(args)
		if errors.Is(err, errRestart) {
			err = reexec()
		}
	case "add":
		err = add(args)
	case "status":
		err = status()
	case "service":
		err = serviceCmd(args)
	case "update":
		err = selfUpdate()
	case "desktop":
		err = desktopCmd(args)
	case "uninstall":
		err = uninstall(args)
	case "version", "--version", "-v":
		fmt.Println(version.Version)
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", cmd, usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "everywhere:", err)
		if errors.Is(err, hub.ErrRevoked) {
			os.Exit(service.ExitRevoked)
		}
		os.Exit(1)
	}
}

func enroll(args []string) error {
	fs := flag.NewFlagSet("enroll", flag.ExitOnError)
	server := fs.String("server", "", "server URL")
	token := fs.String("token", "", "one-time install token")
	_ = fs.Parse(args)
	if *server == "" || *token == "" {
		return errors.New("--server and --token are required")
	}
	hostname, _ := os.Hostname()
	body, _ := json.Marshal(map[string]string{
		"token": *token, "hostname": hostname, "os": runtime.GOOS, "arch": runtime.GOARCH, "version": version.Version,
	})
	url := strings.TrimRight(*server, "/") + "/api/daemon/enroll"
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var out struct {
		DeviceID   string `json:"deviceId"`
		Credential string `json:"credential"`
		Error      string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return fmt.Errorf("enroll: %s", resp.Status)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("enroll: %s", out.Error)
	}
	if err := config.Save(config.Config{Server: strings.TrimRight(*server, "/"), DeviceID: out.DeviceID}, out.Credential); err != nil {
		return err
	}
	fmt.Printf("Enrolled %s as device %s.\n", hostname, out.DeviceID)
	return nil
}

func daemon(args []string) error {
	fs := flag.NewFlagSet("daemon", flag.ExitOnError)
	serverOverride := fs.String("server", "", "override the server URL (for development)")
	verbose := fs.Bool("v", false, "debug logging")
	_ = fs.Parse(args)
	level := slog.LevelInfo
	if *verbose {
		level = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})))

	cfg, credential, err := config.Load()
	if err != nil {
		return err
	}
	if *serverOverride != "" {
		cfg.Server = *serverOverride
	}
	st, err := store.Open(config.DBPath())
	if err != nil {
		return err
	}
	defer st.Close()

	hostname, _ := os.Hostname()
	home, _ := os.UserHomeDir()
	features := []string{protocol.FeatureClaude, protocol.FeatureUpdate, protocol.FeatureWorktrees, protocol.FeatureAttachments, protocol.FeatureHistory, protocol.FeatureArchive, protocol.FeatureTabs, protocol.FeatureRewind, protocol.FeatureIcons, protocol.FeatureClone, protocol.FeatureGitStatus, protocol.FeatureClaudeUpdate}
	if runtime.GOOS == "linux" {
		features = append(features, protocol.FeatureDesktop)
	}
	srv := peer.NewServer(st, protocol.DeviceInfo{
		Hostname: hostname, Home: home, OS: runtime.GOOS, Arch: runtime.GOARCH, Version: version.Version,
		Features: features,
	}, config.DataDir())
	defer srv.Shutdown()
	srv.DesktopEnabled = config.DesktopEnabled
	srv.ICEServers = (&ice.Provider{Server: cfg.Server, Credential: credential}).Servers
	go srv.ICEServers() // warm the cache so the first connection doesn't wait

	hc := &hub.Client{
		Server:          cfg.Server,
		Credential:      credential,
		OnSignal:        srv.HandleSignal,
		OnClientRevoked: srv.CloseClient,
		OnRPC:           srv.Remote,
	}
	srv.SetSignaler(hc.Send)
	srv.SetNotifier(hc.Notify)
	go srv.ContinueAgents() // turns interrupted by an update

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var restart atomic.Bool
	srv.Restart = func() {
		restart.Store(true)
		stop()
	}
	slog.Info("everywhere daemon starting", "version", version.Version, "device", cfg.DeviceID)
	if err := hc.Run(ctx); err != nil {
		return err
	}
	if restart.Load() {
		slog.Info("shutting down to restart")
		return errRestart // main re-execs once the deferred cleanup has run
	}
	slog.Info("shutting down")
	return nil
}

// errRestart asks main to replace the process with the (updated) binary.
var errRestart = errors.New("restart requested")

// reexec replaces this process with the binary on disk, keeping the PID so
// systemd (or whatever started us) sees one continuous run.
func reexec() error {
	exe, err := executable()
	if err != nil {
		return err
	}
	return syscall.Exec(exe, os.Args, os.Environ())
}

func add(args []string) error {
	fs := flag.NewFlagSet("add", flag.ExitOnError)
	name := fs.String("name", "", "project name (default: directory name)")
	// Allow `add PATH --name N` as well as `add --name N PATH`.
	var path string
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		path, args = args[0], args[1:]
	}
	_ = fs.Parse(args)
	if path == "" {
		path = fs.Arg(0)
	}
	if path == "" {
		path = "."
	}
	st, err := store.Open(config.DBPath())
	if err != nil {
		return err
	}
	defer st.Close()
	p, err := st.CreateProject(path, *name)
	if err != nil {
		return err
	}
	fmt.Printf("Added project %q (%s).\n", p.Name, p.Path)
	return nil
}

func status() error {
	cfg, _, err := config.Load()
	if errors.Is(err, config.ErrNotEnrolled) {
		fmt.Println("Not enrolled.")
	} else if err != nil {
		return err
	} else {
		fmt.Printf("Server:  %s\nDevice:  %s\n", cfg.Server, cfg.DeviceID)
	}
	fmt.Printf("Version: %s\nService: %s\n", version.Version, service.Status())
	return nil
}

func serviceCmd(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: everywhere service install|uninstall")
	}
	switch args[0] {
	case "install":
		exe, err := executable()
		if err != nil {
			return err
		}
		if err := service.Install(exe); errors.Is(err, service.ErrNoSystemd) {
			fmt.Printf("systemd not found. Run the daemon yourself, e.g.:\n  nohup %s daemon >/tmp/everywhere.log 2>&1 &\n", exe)
			return nil
		} else if err != nil {
			return err
		}
		fmt.Println("Service installed and started.")
		return nil
	case "uninstall":
		return service.Uninstall()
	}
	return fmt.Errorf("unknown service command %q", args[0])
}

func selfUpdate() error {
	exe, err := executable()
	if err != nil {
		return err
	}
	fmt.Printf("Current version %s; downloading latest...\n", version.Version)
	if err := update.Latest(exe); err != nil {
		return err
	}
	fmt.Println("Updated. Restarting service...")
	return service.Restart()
}

func uninstall(args []string) error {
	fs := flag.NewFlagSet("uninstall", flag.ExitOnError)
	purge := fs.Bool("purge", false, "also delete config, credential, projects and threads")
	_ = fs.Parse(args)
	if err := service.Uninstall(); err != nil {
		return err
	}
	if *purge {
		if err := config.Remove(); err != nil {
			return err
		}
	}
	exe, err := executable()
	if err != nil {
		return err
	}
	if err := os.Remove(exe); err != nil {
		return err
	}
	// The remote desktop worker lives next to the daemon.
	if err := os.Remove(filepath.Join(filepath.Dir(exe), update.WorkerName)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	fmt.Println("Uninstalled. Remove the device in the web UI to revoke its access.")
	return nil
}

func executable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}
