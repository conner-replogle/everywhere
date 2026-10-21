package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/conner-replogle/everywhere/daemon/internal/config"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin/external"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

const pluginUsage = `usage: everywhere plugin <command>

  list                       installed plugins and whether they're on
  install DIR [--yes]        install the plugin in DIR (a plugin.json and its program) and turn it on
  enable ID | disable ID     turn an installed plugin on or off
  remove ID [--purge]        uninstall a plugin (its data, state and settings stay unless --purge)
`

// Plugins are installed and turned on only here, on the device: a web
// session can turn one off but never add code to the machine.
func pluginCmd(args []string) error {
	if len(args) == 0 {
		return errors.New(pluginUsage)
	}
	switch cmd, rest := args[0], args[1:]; cmd {
	case "list":
		return pluginList()
	case "install":
		fs := flag.NewFlagSet("plugin install", flag.ExitOnError)
		yes := fs.Bool("yes", false, "don't ask before installing")
		var dir string
		if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
			dir, rest = rest[0], rest[1:]
		}
		_ = fs.Parse(rest)
		if dir == "" {
			dir = fs.Arg(0)
		}
		if dir == "" {
			return errors.New(pluginUsage)
		}
		return pluginInstall(dir, *yes)
	case "enable", "disable":
		if len(rest) != 1 {
			return errors.New(pluginUsage)
		}
		installed, _ := external.Installed(config.PluginsDir())
		if _, ok := installed[rest[0]]; !ok {
			return fmt.Errorf("no plugin %q is installed", rest[0])
		}
		if err := config.SetPluginEnabled(rest[0], cmd == "enable"); err != nil {
			return err
		}
		fmt.Printf("%s is %s.\n", rest[0], map[bool]string{true: "on", false: "off"}[cmd == "enable"])
		return pluginsChanged()
	case "remove":
		fs := flag.NewFlagSet("plugin remove", flag.ExitOnError)
		purge := fs.Bool("purge", false, "delete its data too")
		if len(rest) == 0 {
			return errors.New(pluginUsage)
		}
		id := rest[0]
		_ = fs.Parse(rest[1:])
		dir := filepath.Join(config.PluginsDir(), id)
		if _, err := os.Stat(filepath.Join(dir, external.ManifestFile)); err != nil {
			return fmt.Errorf("no plugin %q is installed", id)
		}
		if err := config.SetPluginEnabled(id, false); err != nil {
			return err
		}
		if err := os.RemoveAll(dir); err != nil {
			return err
		}
		if *purge {
			_ = os.RemoveAll(filepath.Join(config.DataDir(), "plugin-data", id))
			// Its state and settings, in the daemon's database.
			if st, err := store.Open(config.DBPath()); err == nil {
				_ = st.KVDeletePlugin(id)
				st.Close()
			}
		}
		fmt.Printf("Removed %s.\n", id)
		return pluginsChanged()
	}
	return errors.New(pluginUsage)
}

func pluginList() error {
	installed, bad := external.Installed(config.PluginsDir())
	if len(installed)+len(bad) == 0 {
		fmt.Println("No plugins installed. Built-in plugins are part of the daemon.")
		return nil
	}
	ids := make([]string, 0, len(installed))
	for id := range installed {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		m := installed[id]
		state := "off"
		if config.PluginEnabled(id) {
			state = "on"
		}
		fmt.Printf("%-20s %-4s %s %s\n", id, state, m.Title, m.Version)
	}
	for id, err := range bad {
		fmt.Printf("%-20s bad  %v\n", id, err)
	}
	return nil
}

func pluginInstall(src string, yes bool) error {
	src, err := filepath.Abs(src)
	if err != nil {
		return err
	}
	m, err := external.ReadManifest(src)
	if err != nil {
		return err
	}
	fmt.Printf("%s (%s) %s\n", m.Title, m.ID, m.Version)
	if m.Description != "" {
		fmt.Println(m.Description)
	}
	fmt.Println("\nIt runs as you on this machine and can do anything you can. It asks to:")
	if len(m.Permissions) == 0 {
		fmt.Println("  (nothing beyond its own methods and channels)")
	}
	for _, p := range m.Permissions {
		fmt.Printf("  - %s\n", permissionText(p))
	}
	c := m.Contributes
	if len(c.Tools) > 0 {
		names := make([]string, 0, len(c.Tools))
		for _, t := range c.Tools {
			n := m.ToolName(t.Name)
			if !t.Ask {
				n += " (without asking)"
			}
			names = append(names, n)
		}
		fmt.Printf("Tools for Claude: %s\n", strings.Join(names, ", "))
	}
	var remote []string
	for _, r := range c.RPC {
		if r.Remote {
			remote = append(remote, r.Method)
		}
	}
	if len(remote) > 0 {
		fmt.Printf("Usable by connected agents (MCP): %s\n", strings.Join(remote, ", "))
	}
	if !yes {
		fmt.Print("\nInstall and turn it on? [y/N] ")
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		if a := strings.ToLower(strings.TrimSpace(line)); a != "y" && a != "yes" {
			return errors.New("not installed")
		}
	}
	dst := filepath.Join(config.PluginsDir(), m.ID)
	if src != dst {
		tmp := dst + ".new"
		_ = os.RemoveAll(tmp)
		if err := copyDir(src, tmp); err != nil {
			_ = os.RemoveAll(tmp)
			return err
		}
		_ = os.RemoveAll(dst)
		if err := os.Rename(tmp, dst); err != nil {
			return err
		}
	}
	if err := config.SetPluginEnabled(m.ID, true); err != nil {
		return err
	}
	fmt.Printf("Installed %s.\n", m.ID)
	return pluginsChanged()
}

// permissionText says what a permission lets a plugin do.
func permissionText(p string) string {
	switch p {
	case "fs.read":
		return "read files"
	case "fs.write":
		return "write files"
	case "exec":
		return "run commands"
	case "pty":
		return "run terminals"
	case "net.loopback":
		return "listen on this machine"
	case "agent.tools":
		return "give Claude tools"
	case "agent.notify":
		return "send messages to Claude threads"
	case "agent.read":
		return "read Claude threads"
	case "agent.launch":
		return "add to Claude's system prompt"
	case "browser":
		return "drive the device's browser"
	case "screen":
		return "see and control the screen"
	case "secrets":
		return "use account secrets"
	case "remote":
		return "be used by agents connected to your account (MCP)"
	}
	return p
}

// pluginsChanged says when a change takes effect: a running daemon looks at
// its plugins every few seconds, so nothing restarts (which would end the
// terminals and claude turns on the machine).
func pluginsChanged() error {
	fmt.Println("A running daemon picks this up within a few seconds.")
	return nil
}

func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case d.IsDir():
			return os.MkdirAll(target, 0o755)
		case d.Type()&fs.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		case !d.Type().IsRegular():
			return nil
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, in); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	})
}
