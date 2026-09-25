// Package code is what an agent needs to work on a codebase over MCP: run a
// command, and read, write, edit, list and search files. Paths are absolute
// by the time they get here; the caller resolves them against a project or
// thread.
package code

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	// Output kept per stream; the end is kept, since that's where errors are.
	MaxStreamBytes = 64 << 10
	// A file bigger than this isn't read (use offset/limit on smaller ones).
	MaxReadFileBytes = 10 << 20
	// What one read returns at most.
	MaxReadBytes     = 256 << 10
	DefaultReadLines = 2000
	maxLineChars     = 2000
	// A file bigger than this isn't edited or overwritten by mistake of a huge paste.
	MaxWriteBytes = 5 << 20
)

// --- run a command ---------------------------------------------------------------

type ExecResult struct {
	ExitCode   int    `json:"exitCode"` // -1 if it didn't exit on its own
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	StdoutCut  int    `json:"stdoutCut,omitempty"` // bytes dropped from the start
	StderrCut  int    `json:"stderrCut,omitempty"`
	TimedOut   bool   `json:"timedOut,omitempty"`
	DurationMs int64  `json:"durationMs"`
	Cwd        string `json:"cwd"`
}

// Exec runs command with bash (or sh) -c in dir, with env, killing it and
// everything it started once timeout passes.
func Exec(ctx context.Context, dir, command, stdin string, timeout time.Duration, env []string) (ExecResult, error) {
	res := ExecResult{Cwd: dir}
	if strings.TrimSpace(command) == "" {
		return res, errors.New("command is empty")
	}
	shell := "/bin/sh"
	if p, err := exec.LookPath("bash"); err == nil {
		shell = p
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.Command(shell, "-c", command)
	cmd.Dir = dir
	if env != nil {
		cmd.Env = env
	}
	cmd.Env = append(cmd.Environ(), "EVERYWHERE_MCP=1", "GIT_TERMINAL_PROMPT=0", "PAGER=cat", "GIT_PAGER=cat", "NO_COLOR=1")
	cmd.Stdin = strings.NewReader(stdin)
	stdout, stderr := &tailBuffer{max: MaxStreamBytes}, &tailBuffer{max: MaxStreamBytes}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	// Its own process group, so a timeout takes its children down too.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	start := time.Now()
	if err := cmd.Start(); err != nil {
		return res, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var err error
	select {
	case err = <-done:
	case <-ctx.Done():
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		err = <-done
		res.TimedOut = true
	}
	res.DurationMs = time.Since(start).Milliseconds()
	res.Stdout, res.StdoutCut = stdout.String(), stdout.cut
	res.Stderr, res.StderrCut = stderr.String(), stderr.cut
	res.ExitCode = cmd.ProcessState.ExitCode()
	var exitErr *exec.ExitError
	if err != nil && !errors.As(err, &exitErr) && !res.TimedOut {
		return res, err
	}
	return res, nil
}

// tailBuffer keeps the last max bytes written to it.
type tailBuffer struct {
	max int
	buf []byte
	cut int
}

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.buf = append(b.buf, p...)
	if over := len(b.buf) - b.max; over > 0 {
		b.buf = append(b.buf[:0], b.buf[over:]...)
		b.cut += over
	}
	return len(p), nil
}

func (b *tailBuffer) String() string {
	s := b.buf
	if b.cut > 0 {
		// Don't start in the middle of a UTF-8 sequence.
		for len(s) > 0 && !utf8.RuneStart(s[0]) {
			s = s[1:]
		}
	}
	return string(s)
}

// --- read ------------------------------------------------------------------------

type ReadResult struct {
	Path string `json:"path"`
	// Content is the lines, each prefixed with its number and a tab.
	Content    string `json:"content"`
	StartLine  int    `json:"startLine"`
	EndLine    int    `json:"endLine"`
	TotalLines int    `json:"totalLines"`
	// Truncated: there's more after EndLine.
	Truncated bool `json:"truncated,omitempty"`
}

// Read returns limit lines of a text file from line offset (1-based).
func Read(path string, offset, limit int) (ReadResult, error) {
	res := ReadResult{Path: path}
	fi, err := os.Stat(path)
	if err != nil {
		return res, err
	}
	if fi.IsDir() {
		return res, fmt.Errorf("%s is a directory; use glob to list it", path)
	}
	if fi.Size() > MaxReadFileBytes {
		return res, fmt.Errorf("%s is %d MB; read it in parts with run_command (e.g. sed -n)", path, fi.Size()>>20)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return res, err
	}
	if bytes.IndexByte(data[:min(len(data), 8000)], 0) >= 0 {
		return res, fmt.Errorf("%s looks like a binary file", path)
	}
	lines := strings.Split(string(data), "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	res.TotalLines = len(lines)
	if offset < 1 {
		offset = 1
	}
	if limit <= 0 {
		limit = DefaultReadLines
	}
	if offset > len(lines) && len(lines) > 0 {
		return res, fmt.Errorf("offset %d is past the end (%d lines)", offset, len(lines))
	}
	var b strings.Builder
	res.StartLine, res.EndLine = offset, offset-1
	for i := offset - 1; i < len(lines) && i < offset-1+limit; i++ {
		line := strings.TrimSuffix(lines[i], "\r")
		if len(line) > maxLineChars {
			line = line[:maxLineChars] + "… (line cut)"
		}
		entry := fmt.Sprintf("%6d\t%s\n", i+1, line)
		if b.Len()+len(entry) > MaxReadBytes {
			break
		}
		b.WriteString(entry)
		res.EndLine = i + 1
	}
	res.Content = b.String()
	res.Truncated = res.EndLine < len(lines)
	return res, nil
}

// --- write and edit -------------------------------------------------------------------

type WriteResult struct {
	Path    string `json:"path"`
	Bytes   int    `json:"bytes"`
	Created bool   `json:"created"`
}

// Write replaces (or creates, with its directories) a file's content,
// keeping an existing file's permissions.
func Write(path, content string) (WriteResult, error) {
	res := WriteResult{Path: path, Bytes: len(content)}
	if len(content) > MaxWriteBytes {
		return res, fmt.Errorf("content is over %d MB", MaxWriteBytes>>20)
	}
	mode := os.FileMode(0o644)
	fi, err := os.Stat(path)
	switch {
	case err == nil && fi.IsDir():
		return res, fmt.Errorf("%s is a directory", path)
	case err == nil:
		mode = fi.Mode().Perm()
	case errors.Is(err, os.ErrNotExist):
		res.Created = true
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return res, err
		}
	default:
		return res, err
	}
	return res, writeAtomic(path, []byte(content), mode)
}

// writeAtomic writes through a temp file in the same directory, so a
// reader never sees half a file.
func writeAtomic(path string, data []byte, mode os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".everywhere-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

type EditResult struct {
	Path         string `json:"path"`
	Replacements int    `json:"replacements"`
}

// Edit replaces old with new in a file: exactly one occurrence, or every
// one with all.
func Edit(path, old, new string, all bool) (EditResult, error) {
	res := EditResult{Path: path}
	if old == "" {
		return res, errors.New("old_string is empty; use write_file to create a file")
	}
	if old == new {
		return res, errors.New("old_string and new_string are the same")
	}
	fi, err := os.Stat(path)
	if err != nil {
		return res, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return res, err
	}
	text := string(data)
	n := strings.Count(text, old)
	switch {
	case n == 0:
		return res, errors.New("old_string wasn't found; read the file again and copy the text exactly, whitespace included")
	case n > 1 && !all:
		return res, fmt.Errorf("old_string occurs %d times; add surrounding lines to make it unique, or set replace_all", n)
	}
	if all {
		text = strings.ReplaceAll(text, old, new)
	} else {
		text = strings.Replace(text, old, new, 1)
		n = 1
	}
	res.Replacements = n
	return res, writeAtomic(path, []byte(text), fi.Mode().Perm())
}

// --- list and search ---------------------------------------------------------------------

// skipDirs are never walked into when listing outside a git repo.
var skipDirs = map[string]bool{".git": true, "node_modules": true, ".venv": true, "__pycache__": true, "target": true, "dist": true, ".next": true}

type GlobResult struct {
	Dir   string   `json:"dir"`
	Files []string `json:"files"` // relative to Dir, newest first
	// Truncated: more matched than were returned.
	Truncated bool `json:"truncated,omitempty"`
}

// Glob lists the files under dir matching pattern ("**/*.go", "src/*.ts"),
// newest first. In a git repo it follows .gitignore.
func Glob(ctx context.Context, dir, pattern string, limit int) (GlobResult, error) {
	res := GlobResult{Dir: dir, Files: []string{}}
	if pattern == "" {
		pattern = "**/*"
	}
	re, err := globRegexp(pattern)
	if err != nil {
		return res, err
	}
	files, err := listFiles(ctx, dir)
	if err != nil {
		return res, err
	}
	type hit struct {
		path string
		mod  time.Time
	}
	var hits []hit
	for _, f := range files {
		if re.MatchString(f) {
			var mod time.Time
			if fi, err := os.Stat(filepath.Join(dir, f)); err == nil {
				mod = fi.ModTime()
			}
			hits = append(hits, hit{f, mod})
		}
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].mod.After(hits[j].mod) })
	if limit <= 0 {
		limit = 200
	}
	if len(hits) > limit {
		hits, res.Truncated = hits[:limit], true
	}
	for _, h := range hits {
		res.Files = append(res.Files, h.path)
	}
	return res, nil
}

// listFiles is every file under dir, relative: git's view (tracked plus
// untracked, minus ignored) in a repo, else a walk that skips the usual
// heavy directories.
func listFiles(ctx context.Context, dir string) ([]string, error) {
	cmd := exec.CommandContext(ctx, "git", "ls-files", "-z", "--cached", "--others", "--exclude-standard")
	cmd.Dir = dir
	if out, err := cmd.Output(); err == nil {
		var files []string
		for _, f := range strings.Split(string(out), "\x00") {
			if f != "" {
				files = append(files, f)
			}
		}
		return files, nil
	}
	var files []string
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable: skip
		}
		if d.IsDir() {
			if p != dir && skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if len(files) >= 100_000 {
			return filepath.SkipAll
		}
		rel, _ := filepath.Rel(dir, p)
		files = append(files, filepath.ToSlash(rel))
		return ctx.Err()
	})
	return files, err
}

// globRegexp turns a glob into an anchored regexp: ** spans directories,
// * and ? don't, {a,b} is either. A pattern without a slash matches the
// file name in any directory.
func globRegexp(pattern string) (*regexp.Regexp, error) {
	pattern = strings.TrimPrefix(filepath.ToSlash(pattern), "./")
	if !strings.Contains(pattern, "/") {
		pattern = "**/" + pattern
	}
	var b strings.Builder
	b.WriteString("^")
	depth := 0
	for i := 0; i < len(pattern); i++ {
		c := pattern[i]
		switch {
		case c == '*' && i+1 < len(pattern) && pattern[i+1] == '*':
			i++
			if i+1 < len(pattern) && pattern[i+1] == '/' {
				i++
				b.WriteString("(?:.*/)?")
			} else {
				b.WriteString(".*")
			}
		case c == '*':
			b.WriteString("[^/]*")
		case c == '?':
			b.WriteString("[^/]")
		case c == '{':
			depth++
			b.WriteString("(?:")
		case c == '}' && depth > 0:
			depth--
			b.WriteString(")")
		case c == ',' && depth > 0:
			b.WriteString("|")
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	b.WriteString("$")
	return regexp.Compile(b.String())
}

type GrepOptions struct {
	Pattern    string `json:"pattern"`
	Glob       string `json:"glob"`       // only files matching this
	IgnoreCase bool   `json:"ignoreCase"` //
	FilesOnly  bool   `json:"filesOnly"`  // just the names of matching files
	Context    int    `json:"context"`    // lines around each match
	Limit      int    `json:"limit"`      // lines (or files) returned at most
}

type GrepResult struct {
	Dir    string `json:"dir"`
	Output string `json:"output"` // path:line:text lines, or file names
	Count  int    `json:"count"`
	// Truncated: there were more than Limit.
	Truncated bool `json:"truncated,omitempty"`
}

// Grep searches files under dir (a file, too) for a regular expression,
// with ripgrep if it's installed and grep otherwise.
func Grep(ctx context.Context, dir string, o GrepOptions, env []string) (GrepResult, error) {
	res := GrepResult{Dir: dir}
	if o.Pattern == "" {
		return res, errors.New("pattern is empty")
	}
	if o.Limit <= 0 {
		o.Limit = 200
	}
	var args []string
	name := "rg"
	if _, err := exec.LookPath("rg"); err == nil {
		args = []string{"--no-heading", "--line-number", "--color=never", "--max-columns=400", "--max-columns-preview"}
		if o.FilesOnly {
			args = []string{"--files-with-matches", "--color=never"}
		}
		if o.IgnoreCase {
			args = append(args, "--ignore-case")
		}
		if o.Context > 0 && !o.FilesOnly {
			args = append(args, fmt.Sprintf("--context=%d", min(o.Context, 10)))
		}
		if o.Glob != "" {
			args = append(args, "--glob", o.Glob)
		}
		args = append(args, "--regexp", o.Pattern, "--", ".")
	} else {
		name = "grep"
		args = []string{"-rIn", "-E", "--color=never", "--exclude-dir=.git", "--exclude-dir=node_modules"}
		if o.FilesOnly {
			args = append(args, "-l")
		}
		if o.IgnoreCase {
			args = append(args, "-i")
		}
		if o.Context > 0 && !o.FilesOnly {
			args = append(args, fmt.Sprintf("-C%d", min(o.Context, 10)))
		}
		if o.Glob != "" {
			args = append(args, "--include="+o.Glob)
		}
		args = append(args, "-e", o.Pattern, "--", ".")
	}
	target := dir
	if fi, err := os.Stat(dir); err == nil && !fi.IsDir() {
		target = filepath.Dir(dir)
		args[len(args)-1] = filepath.Base(dir)
	}
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = target
	if env != nil {
		cmd.Env = env
	}
	out := &tailBuffer{max: 4 << 20}
	var stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = out, &stderr
	err := cmd.Run()
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return res, nil // no matches
	}
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return res, fmt.Errorf("%s: %s", name, msg)
	}
	lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
	for i, l := range lines {
		lines[i] = strings.TrimPrefix(l, "./")
	}
	res.Count = len(lines)
	if len(lines) > o.Limit {
		lines, res.Truncated = lines[:o.Limit], true
	}
	res.Output = strings.Join(lines, "\n")
	return res, nil
}
