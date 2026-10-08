package peer

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/user"
	"path/filepath"
	"strings"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
	"github.com/conner-replogle/everywhere/daemon/internal/store"
)

// Scratch is Everywhere's own project for work outside any project: each
// thread gets a folder of its own under the data directory, kept until the
// user deletes it.

const (
	// handoffMessageMax and handoffMax bound the earlier conversation a
	// thread continued elsewhere starts with: per message, and in all.
	handoffMessageMax = 1500
	handoffMax        = 12000
	// scratchUsageMax is how many entries scratch.usage counts before it
	// gives up.
	scratchUsageMax = 200_000
)

// promote makes a Scratch thread's folder a project, with the thread in it.
func (s *Server) promote(threadID, name string) (protocol.Project, error) {
	p, err := s.store.PromoteThread(threadID, name)
	if err != nil {
		return p, err
	}
	s.broadcast(protocol.EventProjectsChanged)
	s.broadcast(protocol.EventThreadsChanged)
	return p, nil
}

// continueIn starts a claude thread in another project that picks up where
// a claude thread left off: claude can't change directory mid-session, so
// the new one starts with the conversation so far.
func (s *Server) continueIn(threadID, projectID, mode string) (protocol.Thread, error) {
	from, err := s.claudeThread(threadID)
	if err != nil {
		return from, err
	}
	if from.ParentID != "" {
		return protocol.Thread{}, errors.New("continue the tab's thread instead")
	}
	if from.ProjectID == projectID {
		return protocol.Thread{}, errors.New("the thread is already in that project")
	}
	wd, err := s.workdir(threadID)
	if err != nil {
		return protocol.Thread{}, err
	}
	events, _, err := s.store.AgentEvents(threadID, 0, 0, 1000)
	if err != nil {
		return protocol.Thread{}, err
	}
	t, err := s.store.CreateThread(projectID, from.Name, protocol.ThreadClaude)
	if err != nil {
		return t, err
	}
	if err := s.initialMode(t, mode); err != nil {
		return t, err
	}
	s.broadcast(protocol.EventThreadsChanged)
	prompt := handoffPrompt(from.Name, wd.Path, events)
	if err := s.agents.Request(t.ID, protocol.AgentClientMsg{T: "send", Text: prompt}); err != nil {
		return t, err
	}
	return t, nil
}

// handoffPrompt is the first prompt of a thread that continues another:
// where that one worked and its conversation, the newest part if it's long.
func handoffPrompt(name, dir string, events []store.AgentEvent) string {
	var msgs []string
	for _, e := range events {
		var ev protocol.AgentEvent
		if err := json.Unmarshal(e.Event, &ev); err != nil || ev.ParentID != "" || strings.TrimSpace(ev.Text) == "" {
			continue
		}
		who := ""
		switch ev.Type {
		case "user":
			if strings.TrimSpace(ev.Text) == "/recap" {
				continue
			}
			who = "User"
		case "assistant":
			who = "Claude"
		default:
			continue
		}
		text := strings.TrimSpace(ev.Text)
		if r := []rune(text); len(r) > handoffMessageMax {
			text = string(r[:handoffMessageMax]) + " […]"
		}
		msgs = append(msgs, who+": "+text)
	}
	// Keep the newest messages that fit.
	total, first := 0, len(msgs)
	for first > 0 && total+len(msgs[first-1]) <= handoffMax {
		first--
		total += len(msgs[first]) + 2
	}
	var b strings.Builder
	fmt.Fprintf(&b, "This continues the Everywhere thread %q, which worked in %s on this device. ", name, dir)
	b.WriteString("Its files are still there. Here is its conversation so far, oldest first")
	if first > 0 {
		fmt.Fprintf(&b, " (the first %d messages are left out)", first)
	}
	b.WriteString(", with long messages cut.\n\n<previous-thread>\n")
	b.WriteString(strings.Join(msgs[first:], "\n\n"))
	b.WriteString("\n</previous-thread>\n\n")
	b.WriteString("Pick up where it left off. Start with a short summary of where things stand and what's next, ")
	b.WriteString("then carry on if the next step is clear, or ask.")
	return b.String()
}

// scratchUsage counts the files in Scratch, in all and per thread folder.
func (s *Server) scratchUsage() (protocol.ScratchUsage, error) {
	root := s.store.ScratchRoot()
	u := protocol.ScratchUsage{Root: root, Folders: map[string]protocol.ScratchSize{}}
	seen := 0
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // unreadable: skip it
		}
		if seen++; seen > scratchUsageMax {
			u.Truncated = true
			return filepath.SkipAll
		}
		rel, _ := filepath.Rel(root, path)
		top, _, _ := strings.Cut(rel, string(filepath.Separator))
		if top == "." {
			return nil
		}
		folder := filepath.Join(root, top)
		size := u.Folders[folder]
		if !d.IsDir() {
			if info, err := d.Info(); err == nil {
				size.Files++
				size.Bytes += info.Size()
				u.Files++
				u.Bytes += info.Size()
			}
		}
		// Folders are listed even while they're empty.
		u.Folders[folder] = size
		return nil
	})
	return u, err
}

// removeScratch deletes a deleted thread's scratch folder, when asked to.
func (s *Server) removeScratch(dir string) error {
	if dir == "" {
		return nil
	}
	if !s.store.InScratch(dir) {
		return fmt.Errorf("%s isn't a scratch folder", dir)
	}
	return os.RemoveAll(dir)
}

// scratchPrompt is what a Scratch thread's claude is told about where it
// is, appended to its system prompt.
func (s *Server) scratchPrompt(dir string) string {
	who := "the device's user"
	if u, err := user.Current(); err == nil && u.Username != "" {
		who = u.Username
	}
	host := s.info.Hostname
	if host == "" {
		host = "this device"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "You're working in Everywhere's Scratch mode on %s (%s/%s): general computer work outside any project, ", host, s.info.OS, s.info.Arch)
	b.WriteString("such as diagnosing a problem with the computer, looking something up on it, or a quick task with some files. ")
	b.WriteString("The user may be on another device (often a phone), using this computer remotely through Everywhere.\n\n")
	fmt.Fprintf(&b, "Your working directory, %s, is this thread's own scratch folder. ", dir)
	b.WriteString("Put files you make there (scripts, downloads, reports, converted files); it's kept until the user deletes it. ")
	b.WriteString("You can read and work anywhere on the computer as needed, but don't scatter files elsewhere unless asked.\n\n")
	fmt.Fprintf(&b, "You run as %s, without root. sudo can't work here: no password prompt reaches you. ", who)
	b.WriteString("When something needs root, show the exact command in a fenced sh code block that starts with sudo, and say why: ")
	b.WriteString("the user can open it in a terminal tab with one click, check it and run it with their password.\n\n")
	b.WriteString("Diagnose with read-only commands first (logs, status, listings) and explain what you find in plain terms. ")
	b.WriteString("Before you change the system (services, packages, settings, config files outside your folder, deleting anything), ")
	b.WriteString("say what you'll change and why, and how to undo it.")
	if s.desktop != nil {
		if d := s.desktop.Info(); d.Enabled && d.Available {
			b.WriteString("\n\nThe mcp__everywhere__desktop_* tools let you see and use the computer's screen when that helps.")
		}
	}
	return b.String()
}
