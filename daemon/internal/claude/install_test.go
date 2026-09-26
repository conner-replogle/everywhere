package claude

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func writeExe(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateCommand(t *testing.T) {
	root := t.TempDir()

	// The native installer: a symlink into ~/.local/share/claude/versions.
	native := filepath.Join(root, "home", ".local", "share", "claude", "versions", "2.1.0")
	writeExe(t, native)
	link := filepath.Join(root, "home", ".local", "bin", "claude")
	os.MkdirAll(filepath.Dir(link), 0o755)
	if err := os.Symlink(native, link); err != nil {
		t.Fatal(err)
	}
	if got := UpdateCommand(link, nil); !slices.Equal(got, []string{link, "update"}) {
		t.Errorf("native: %q", got)
	}

	// npm global under a writable prefix, with npm beside it.
	prefix := filepath.Join(root, "npm")
	cli := filepath.Join(prefix, "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js")
	writeExe(t, cli)
	writeExe(t, filepath.Join(prefix, "bin", "npm"))
	bin := filepath.Join(prefix, "bin", "claude")
	os.Symlink(cli, bin)
	want := []string{filepath.Join(prefix, "bin", "npm"), "install", "--global", "--prefix", prefix, Package + "@latest"}
	if got := UpdateCommand(bin, nil); !slices.Equal(got, want) {
		t.Errorf("npm: %q, want %q", got, want)
	}

	// A project's node_modules isn't a global install.
	local := filepath.Join(root, "proj", "node_modules", ".pnpm", "x", "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js")
	writeExe(t, local)
	if got := UpdateCommand(local, nil); got != nil {
		t.Errorf("project install: %q", got)
	}

	// Anything else is updated by hand.
	other := filepath.Join(root, "opt", "claude")
	writeExe(t, other)
	if got := UpdateCommand(other, nil); got != nil {
		t.Errorf("unknown install: %q", got)
	}
}

func TestBuildChangesWithTheInstall(t *testing.T) {
	root := t.TempDir()
	a, b := filepath.Join(root, "versions", "1"), filepath.Join(root, "versions", "2")
	writeExe(t, a)
	writeExe(t, b)
	link := filepath.Join(root, "claude")
	os.Symlink(a, link)
	first, err := Build(link, nil)
	if err != nil {
		t.Fatal(err)
	}
	os.Remove(link)
	os.Symlink(b, link)
	if second, _ := Build(link, nil); second == first {
		t.Error("repointing the symlink didn't change the build")
	}
}

func TestResolveLooksThroughAMiseShim(t *testing.T) {
	root := t.TempDir()
	// A mise that knows no active claude (exits non-zero), shimmed first on PATH.
	mise := filepath.Join(root, "bin", "mise")
	if err := os.MkdirAll(filepath.Dir(mise), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mise, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	shims := filepath.Join(root, "shims")
	os.MkdirAll(shims, 0o755)
	os.Symlink(mise, filepath.Join(shims, "claude"))
	native := filepath.Join(root, "home", ".local", "share", "claude", "versions", "2.1.0")
	writeExe(t, native)
	local := filepath.Join(root, "home", ".local", "bin")
	os.MkdirAll(local, 0o755)
	os.Symlink(native, filepath.Join(local, "claude"))

	env := []string{"PATH=" + shims + string(os.PathListSeparator) + local}
	if got, err := Resolve(filepath.Join(shims, "claude"), env); err != nil || got != native {
		t.Errorf("Resolve = %q, %v; want the claude after the shim, %q", got, err, native)
	}
	if got := UpdateCommand(filepath.Join(shims, "claude"), env); !slices.Equal(got, []string{filepath.Join(local, "claude"), "update"}) {
		t.Errorf("UpdateCommand = %q", got)
	}
}
