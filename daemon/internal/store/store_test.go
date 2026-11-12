package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestProjectsAndThreads(t *testing.T) {
	s := open(t)
	projects, err := s.ListProjects()
	if err != nil || len(projects) != 2 || !projects[0].IsHome || !projects[1].IsScratch {
		t.Fatalf("want seeded home and Scratch projects, got %+v %v", projects, err)
	}
	home := projects[0]
	if err := s.DeleteProject(home.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("deleting home project: err = %v, want ErrNotFound", err)
	}

	dir := t.TempDir()
	p, err := s.CreateProject(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if p.Name != filepath.Base(dir) {
		t.Errorf("default name = %q", p.Name)
	}
	if _, err := s.CreateProject(dir, "dup"); err == nil {
		t.Error("duplicate path accepted")
	}
	if _, err := s.CreateProject(filepath.Join(dir, "missing"), ""); err == nil {
		t.Error("missing directory accepted")
	}

	th, err := s.CreateThread(p.ID, "", "")
	if err != nil || th.Name != "terminal 1" {
		t.Fatalf("CreateThread = %+v, %v", th, err)
	}
	gotDir, had, err := s.ThreadShell(th.ID)
	if err != nil || gotDir != dir || had {
		t.Fatalf("ThreadShell = %q %v %v", gotDir, had, err)
	}
	if err := s.MarkSpawned(th.ID); err != nil {
		t.Fatal(err)
	}
	if _, had, _ := s.ThreadShell(th.ID); !had {
		t.Error("had_session not set after MarkSpawned")
	}

	// Deleting a project cascades to its threads.
	if err := s.DeleteProject(p.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetThread(th.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("thread survived project delete: %v", err)
	}
}

// A database created before migrations were versioned (user_version 0, V1
// schema) must upgrade in place.
func TestMigratesUnversionedV1Database(t *testing.T) {
	path := filepath.Join(t.TempDir(), "v1.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(migrations[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
INSERT INTO projects (id, name, path, is_home, created_at) VALUES ('p1', 'home', '/', 1, 1);
INSERT INTO threads (id, project_id, name, created_at) VALUES ('t1', 'p1', 'old', 1);`); err != nil {
		t.Fatal(err)
	}
	db.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	th, err := s.GetThread("t1")
	if err != nil || th.Kind != protocol.ThreadTerminal || th.Name != "old" {
		t.Fatalf("GetThread = %+v, %v", th, err)
	}
	var v int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&v); err != nil || v != len(migrations) {
		t.Fatalf("user_version = %d, %v", v, err)
	}
}

func TestAgentThreads(t *testing.T) {
	s := open(t)
	projects, _ := s.ListProjects()
	home := projects[0]

	// Which kinds run agents is the agent plugin's to say; the store reports the kind.
	term, _ := s.CreateThread(home.ID, "", "")
	if a, err := s.AgentThread(term.ID); err != nil || a.Kind != protocol.ThreadTerminal {
		t.Errorf("AgentThread(terminal) = kind %q, %v", a.Kind, err)
	}
	// Plugins decide which kinds exist; the store only refuses malformed ones.
	if _, err := s.CreateThread(home.ID, "", "bad kind!"); err == nil {
		t.Error("malformed kind accepted")
	}
	th, err := s.CreateThread(home.ID, "", protocol.ThreadClaude)
	if err != nil || th.Name != "claude 1" || th.Kind != protocol.ThreadClaude {
		t.Fatalf("CreateThread = %+v, %v", th, err)
	}

	a, err := s.AgentThread(th.ID)
	if err != nil || a.Dir != home.Path || a.SessionID != "" || a.Model != "" || a.PermissionMode != "default" {
		t.Fatalf("AgentThread = %+v, %v", a, err)
	}
	if err := s.SetAgentSessionID(th.ID, "sess"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentModel(th.ID, "haiku"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentPermissionMode(th.ID, "plan"); err != nil {
		t.Fatal(err)
	}
	if a, _ := s.AgentThread(th.ID); a.SessionID != "sess" || a.Model != "haiku" || a.PermissionMode != "plan" {
		t.Fatalf("after updates: %+v", a)
	}
	if a, _ := s.AgentThread(th.ID); a.Workspace != "local" || a.Worktree != "" || a.Continue || a.Context != nil {
		t.Fatalf("workspace defaults: %+v", a)
	}
	if err := s.SetAgentWorkspace(th.ID, "worktree", "main"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentWorktree(th.ID, "/wt", "everywhere/x"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentContinue(th.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentContext(th.ID, json.RawMessage(`{"used":1}`)); err != nil {
		t.Fatal(err)
	}
	a, _ = s.AgentThread(th.ID)
	if a.Workspace != "worktree" || a.BaseBranch != "main" || a.Worktree != "/wt" || a.Branch != "everywhere/x" ||
		!a.Continue || string(a.Context) != `{"used":1}` {
		t.Fatalf("after workspace updates: %+v", a)
	}
	if !a.Thinking || a.Effort != "" {
		t.Fatalf("effort/thinking defaults: %+v", a)
	}
	if err := s.SetAgentEffort(th.ID, "max"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentThinking(th.ID, false); err != nil {
		t.Fatal(err)
	}
	if a, _ := s.AgentThread(th.ID); a.Effort != "max" || a.Thinking {
		t.Fatalf("after effort/thinking: %+v", a)
	}
	if ids, err := s.AgentThreadsToContinue(); err != nil || len(ids) != 1 || ids[0] != th.ID {
		t.Fatalf("AgentThreadsToContinue = %v, %v", ids, err)
	}

	for i := range 5 {
		e, err := s.AppendAgentEvent(th.ID, json.RawMessage(fmt.Sprintf(`{"n":%d}`, i)))
		if err != nil || e.Seq != int64(i+1) {
			t.Fatalf("append %d: seq %d, %v", i, e.Seq, err)
		}
	}
	events, truncated, err := s.AgentEvents(th.ID, 1, 0, 2)
	if err != nil || !truncated || len(events) != 2 || events[0].Seq != 4 || events[1].Seq != 5 {
		t.Fatalf("AgentEvents(after 1, limit 2) = %+v truncated=%v %v", events, truncated, err)
	}
	events, truncated, _ = s.AgentEvents(th.ID, 3, 0, 10)
	if truncated || len(events) != 2 || string(events[0].Event) != `{"n":3}` {
		t.Fatalf("AgentEvents(after 3) = %+v truncated=%v", events, truncated)
	}
	events, more, _ := s.AgentEvents(th.ID, 0, 4, 2)
	if !more || len(events) != 2 || events[0].Seq != 2 || events[1].Seq != 3 {
		t.Fatalf("AgentEvents(before 4, limit 2) = %+v more=%v", events, more)
	}
	if events, more, _ = s.AgentEvents(th.ID, 0, 3, 10); more || len(events) != 2 || events[0].Seq != 1 {
		t.Fatalf("AgentEvents(before 3) = %+v more=%v", events, more)
	}

	if a, err := s.SetThreadArchived(th.ID, true); err != nil || a.ArchivedAt == nil {
		t.Fatalf("archive: %+v, %v", a, err)
	}
	if got, _ := s.GetThread(th.ID); got.ArchivedAt == nil {
		t.Fatalf("archived thread read back unarchived: %+v", got)
	}
	if a, err := s.SetThreadArchived(th.ID, false); err != nil || a.ArchivedAt != nil {
		t.Fatalf("restore: %+v, %v", a, err)
	}

	if err := s.DeleteThread(th.ID); err != nil {
		t.Fatal(err)
	}
	if events, _, _ := s.AgentEvents(th.ID, 0, 0, 10); len(events) != 0 {
		t.Errorf("events survived thread delete: %d", len(events))
	}
}

func TestTabs(t *testing.T) {
	s := open(t)
	p, err := s.CreateProject(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	th, err := s.CreateThread(p.ID, "", protocol.ThreadClaude)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetAgentWorktree(th.ID, "/wt/x", "everywhere/x"); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{protocol.ThreadTerminal, protocol.ThreadClaude, protocol.ThreadBrowser, protocol.ThreadFiles, protocol.ThreadDesktop} {
		if _, err := s.CreateTab(th.ID, kind, ""); err != nil {
			t.Fatalf("CreateTab(%s): %v", kind, err)
		}
	}
	if _, err := s.CreateTab(th.ID, "bad kind!", ""); err == nil {
		t.Error("malformed kind accepted")
	}
	tabs, err := s.ListTabs(th.ID)
	if err != nil || len(tabs) != 5 {
		t.Fatalf("ListTabs = %d %v", len(tabs), err)
	}
	if _, err := s.CreateTab(tabs[0].ID, protocol.ThreadTerminal, ""); err == nil {
		t.Error("tab of a tab accepted")
	}
	threads, _ := s.ListThreads(p.ID)
	if len(threads) != 1 || threads[0].ID != th.ID {
		t.Errorf("ListThreads includes tabs: %+v", threads)
	}

	// The claude tab shares the thread's worktree; the thread's own isn't shared.
	claudeTab := tabs[1]
	a, err := s.AgentThread(claudeTab.ID)
	if err != nil || a.Workspace != "worktree" || a.Worktree != "/wt/x" || a.Branch != "everywhere/x" || !a.SharedWorktree {
		t.Errorf("claude tab agent = %+v %v", a, err)
	}
	if a, _ := s.AgentThread(th.ID); a.SharedWorktree {
		t.Error("thread's own worktree reported shared")
	}
	if _, wt, err := s.ThreadWorkdir(tabs[0].ID); err != nil || wt != "/wt/x" {
		t.Errorf("terminal tab worktree = %q %v", wt, err)
	}

	if err := s.SetTabState(tabs[3].ID, `{"file":"a"}`); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetThread(tabs[3].ID); got.TabState != `{"file":"a"}` || got.ParentID != th.ID {
		t.Errorf("tab = %+v", got)
	}
	if err := s.SetTabState(th.ID, "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("SetTabState on a thread: %v", err)
	}

	if err := s.DeleteThread(th.ID); err != nil {
		t.Fatal(err)
	}
	if tabs, _ := s.ListTabs(th.ID); len(tabs) != 0 {
		t.Errorf("tabs survive their thread: %+v", tabs)
	}
}

func TestSearchAgentEvents(t *testing.T) {
	s := open(t)
	home, _ := s.ListProjects()
	a, _ := s.CreateThread(home[0].ID, "deploy pipeline", protocol.ThreadClaude)
	b, _ := s.CreateThread(home[0].ID, "", protocol.ThreadClaude)
	for _, ev := range []string{
		`{"type":"user","id":"1","text":"Why is the Frobnicator slow?"}`,
		`{"type":"tool","id":"2","name":"Bash","input":{"command":"frobnicator"}}`,
		`{"type":"assistant","id":"3","text":"The frobnicator takes 100%_ of CPU"}`,
	} {
		if _, err := s.AppendAgentEvent(b.ID, json.RawMessage(ev)); err != nil {
			t.Fatal(err)
		}
	}

	hits, err := s.SearchAgentEvents("FROBNICATOR", 10)
	if err != nil || len(hits) != 1 || hits[0].ThreadID != b.ID {
		t.Fatalf("hits = %+v, %v", hits, err)
	}
	if hits[0].Matches != 3 || hits[0].Role == "name" || hits[0].Snippet == "" || hits[0].Name == "" || hits[0].ProjectName == "" {
		t.Errorf("hit = %+v", hits[0])
	}
	// Every word, in any order, within one message.
	if hits, _ := s.SearchAgentEvents("cpu FROBNICATOR takes", 10); len(hits) != 1 || hits[0].ThreadID != b.ID {
		t.Errorf("words in any order = %+v", hits)
	}
	if hits, _ := s.SearchAgentEvents("slow cpu", 10); len(hits) != 0 {
		t.Errorf("words from two messages matched: %+v", hits)
	}
	if hits, _ := s.SearchAgentEvents("deploy", 10); len(hits) != 1 || hits[0].ThreadID != a.ID || hits[0].Snippet != "" || hits[0].Role != "name" {
		t.Errorf("name search = %+v", hits)
	}
	// A claude tab's messages find its thread.
	tab, err := s.CreateTab(a.ID, protocol.ThreadClaude, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AppendAgentEvent(tab.ID, json.RawMessage(`{"type":"assistant","id":"4","text":"zebra crossing"}`)); err != nil {
		t.Fatal(err)
	}
	if hits, _ := s.SearchAgentEvents("zebra", 10); len(hits) != 1 || hits[0].ThreadID != a.ID || hits[0].TabID != tab.ID || hits[0].Seq != 1 {
		t.Errorf("tab search = %+v", hits)
	}
	// LIKE wildcards in the query are literal.
	if hits, _ := s.SearchAgentEvents("100%_", 10); len(hits) != 1 {
		t.Errorf("literal %%_ = %+v", hits)
	}
	if hits, _ := s.SearchAgentEvents("0_o", 10); len(hits) != 0 {
		t.Errorf("_ matched as a wildcard: %+v", hits)
	}
}

func TestSearchThreads(t *testing.T) {
	s := open(t)
	home, _ := s.ListProjects()
	a, _ := s.CreateThread(home[0].ID, "keyring", protocol.ThreadClaude)
	b, _ := s.CreateThread(home[0].ID, "other", protocol.ThreadClaude)
	add := func(id, ev string) {
		t.Helper()
		if _, err := s.AppendAgentEvent(id, json.RawMessage(ev)); err != nil {
			t.Fatal(err)
		}
	}
	add(a.ID, `{"type":"user","id":"1","text":"pacman says the keyring is corrupted"}`)
	add(a.ID, `{"type":"tool","id":"2","name":"Bash","input":{"command":"sudo pacman-key --populate archlinux"}}`)
	add(b.ID, `{"type":"assistant","id":"3","text":"Ünïcode café and an ok go"}`)
	add(b.ID, `{"type":"turn","status":"completed","text":"keyring in a turn isn't indexed"}`)
	ids := func(q string, o SearchOptions) []string {
		t.Helper()
		hits, err := s.SearchThreads(q, o)
		if err != nil {
			t.Fatal(err)
		}
		out := []string{}
		for _, h := range hits {
			out = append(out, h.ThreadID)
		}
		return out
	}
	// Substrings, as grep: part of a word, a tool call's command.
	if got := ids("keyr", SearchOptions{}); !slices.Equal(got, []string{a.ID}) {
		t.Errorf("substring = %v", got)
	}
	if got := ids("populate", SearchOptions{}); !slices.Equal(got, []string{a.ID}) {
		t.Errorf("tool command = %v", got)
	}
	// A quoted phrase must appear as it is.
	if got := ids(`"keyring is corrupted"`, SearchOptions{}); !slices.Equal(got, []string{a.ID}) {
		t.Errorf("phrase = %v", got)
	}
	if got := ids(`"corrupted keyring"`, SearchOptions{}); len(got) != 0 {
		t.Errorf("phrase out of order = %v", got)
	}
	// Short terms, diacritics, and case.
	if got := ids("ok go", SearchOptions{}); !slices.Equal(got, []string{b.ID}) {
		t.Errorf("short terms = %v", got)
	}
	if got := ids("CAFE unicode", SearchOptions{}); !slices.Equal(got, []string{b.ID}) {
		t.Errorf("diacritics = %v", got)
	}
	// The name matching as well as a message ranks first.
	hits, _ := s.SearchThreads("keyring", SearchOptions{})
	if len(hits) != 1 || hits[0].Role == "name" || hits[0].Score <= 0 {
		t.Errorf("name and text = %+v", hits)
	}
	// Archived threads are found unless left out; a project narrows it.
	if _, err := s.SetThreadArchived(a.ID, true); err != nil {
		t.Fatal(err)
	}
	if got := ids("keyr", SearchOptions{SkipArchived: true}); len(got) != 0 {
		t.Errorf("archived found = %v", got)
	}
	if hits, _ := s.SearchThreads("keyr", SearchOptions{}); len(hits) != 1 || hits[0].ArchivedAt == nil {
		t.Errorf("archived = %+v", hits)
	}
	if got := ids("keyr", SearchOptions{ProjectID: "nope"}); len(got) != 0 {
		t.Errorf("other project = %v", got)
	}
	// Rewound and deleted messages leave the index.
	if err := s.DeleteAgentEvents(a.ID, 2, 3); err != nil {
		t.Fatal(err)
	}
	if got := ids("populate", SearchOptions{}); len(got) != 0 {
		t.Errorf("rewound = %v", got)
	}
	if err := s.DeleteThread(b.ID); err != nil {
		t.Fatal(err)
	}
	if got := ids("café", SearchOptions{}); len(got) != 0 {
		t.Errorf("deleted = %v", got)
	}
	var n int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM search_docs").Scan(&n); err != nil || n != 1 {
		t.Errorf("search_docs = %d, %v", n, err)
	}
}

func TestSearchTerms(t *testing.T) {
	got := searchTerms(`  foo "bar baz"  qux "open`)
	if want := []string{"foo", "bar baz", "qux", "open"}; !slices.Equal(got, want) {
		t.Errorf("terms = %q", got)
	}
}

func TestPinAndSeen(t *testing.T) {
	s := open(t)
	home, _ := s.ListProjects()
	th, _ := s.CreateThread(home[0].ID, "", protocol.ThreadClaude)
	tab, _ := s.CreateTab(th.ID, protocol.ThreadTerminal, "")
	if err := s.SetThreadDone(th.ID, true); err != nil {
		t.Fatal(err)
	}
	// Through a tab, as done: the thread it belongs to.
	if err := s.SetThreadPinned(tab.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := s.SeeThread(tab.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetThread(th.ID)
	if got.PinnedAt == nil || got.SeenAt == nil {
		t.Errorf("thread = %+v", got)
	}
	if got.DoneAt == nil {
		t.Error("seeing a thread cleared done")
	}
	if err := s.SetThreadPinned(th.ID, false); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetThread(th.ID); got.PinnedAt != nil {
		t.Error("still pinned")
	}
	if err := s.SeeThread("nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing = %v", err)
	}
}

func TestTouchThread(t *testing.T) {
	s := open(t)
	p, err := s.CreateProject(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	th, err := s.CreateThread(p.ID, "", protocol.ThreadClaude)
	if err != nil {
		t.Fatal(err)
	}
	tab, err := s.CreateTab(th.ID, protocol.ThreadTerminal, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.MarkSpawned(tab.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetThread(th.ID); got.LastOpenedAt != nil {
		t.Errorf("starting a shell counted as using the thread")
	}
	// Using a tab counts as using its thread.
	if err := s.TouchThread(tab.ID); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{th.ID, tab.ID} {
		if got, err := s.GetThread(id); err != nil || got.LastOpenedAt == nil {
			t.Errorf("GetThread(%s).LastOpenedAt = nil, %v", id, err)
		}
	}
}

func TestScratch(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	s, err := Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	root := filepath.Join(filepath.Dir(dbPath), ScratchDirName)
	scratch, err := s.ScratchProject()
	if err != nil || scratch.Path != root || scratch.Name != "Scratch" {
		t.Fatalf("ScratchProject = %+v, %v", scratch, err)
	}
	if err := s.DeleteProject(scratch.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("deleting Scratch: err = %v, want ErrNotFound", err)
	}
	if _, err := s.RenameProject(scratch.ID, "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("renaming Scratch: err = %v, want ErrNotFound", err)
	}

	// Each thread gets a fresh folder of its own; claude starts in auto.
	a, err := s.CreateThread(scratch.ID, "", protocol.ThreadClaude)
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.CreateThread(scratch.ID, "", protocol.ThreadTerminal)
	if err != nil {
		t.Fatal(err)
	}
	if a.ScratchDir == "" || a.ScratchDir == b.ScratchDir || filepath.Dir(a.ScratchDir) != root ||
		!strings.HasSuffix(a.ScratchDir, "-"+a.ID) {
		t.Fatalf("scratch dirs %q, %q", a.ScratchDir, b.ScratchDir)
	}
	if info, err := os.Stat(a.ScratchDir); err != nil || !info.IsDir() {
		t.Fatalf("scratch dir not made: %v", err)
	}
	if !s.InScratch(a.ScratchDir) || s.InScratch(root) || s.InScratch(filepath.Join(a.ScratchDir, "x")) || s.InScratch(t.TempDir()) {
		t.Error("InScratch wrong")
	}
	agent, err := s.AgentThread(a.ID)
	if err != nil || agent.Dir != a.ScratchDir || !agent.Scratch || agent.PermissionMode != "auto" {
		t.Fatalf("AgentThread = %+v, %v", agent, err)
	}
	if dir, _, err := s.ThreadShell(b.ID); err != nil || dir != b.ScratchDir {
		t.Errorf("ThreadShell = %q, %v", dir, err)
	}
	// Tabs work in their thread's folder.
	tab, err := s.CreateTab(a.ID, protocol.ThreadTerminal, "")
	if err != nil {
		t.Fatal(err)
	}
	if dir, wt, err := s.ThreadWorkdir(tab.ID); err != nil || dir != a.ScratchDir || wt != "" {
		t.Errorf("tab workdir = %q %q %v", dir, wt, err)
	}
	ctab, err := s.CreateTab(a.ID, protocol.ThreadClaude, "")
	if err != nil {
		t.Fatal(err)
	}
	if ag, err := s.AgentThread(ctab.ID); err != nil || ag.Dir != a.ScratchDir || !ag.Scratch {
		t.Errorf("claude tab = %+v, %v", ag, err)
	}
	// Threads elsewhere don't get a folder.
	home, _ := s.ListProjects()
	h, err := s.CreateThread(home[0].ID, "", protocol.ThreadClaude)
	if err != nil || h.ScratchDir != "" {
		t.Fatalf("home thread = %+v, %v", h, err)
	}
	if ag, _ := s.AgentThread(h.ID); ag.Scratch || ag.PermissionMode != "default" {
		t.Errorf("home thread agent = %+v", ag)
	}

	// Promoting: the folder becomes a project, the thread and its tabs move.
	p, err := s.PromoteThread(a.ID, "pdf tools")
	if err != nil || p.Path != a.ScratchDir || p.Name != "pdf tools" || p.IsScratch {
		t.Fatalf("PromoteThread = %+v, %v", p, err)
	}
	moved, _ := s.GetThread(a.ID)
	if moved.ProjectID != p.ID || moved.ScratchDir != "" {
		t.Errorf("promoted thread = %+v", moved)
	}
	if ag, err := s.AgentThread(ctab.ID); err != nil || ag.Dir != a.ScratchDir || ag.Scratch || ag.ProjectID != p.ID {
		t.Errorf("promoted tab = %+v, %v", ag, err)
	}
	if _, err := s.PromoteThread(a.ID, ""); err == nil {
		t.Error("promoted a thread twice")
	}
	if _, err := s.PromoteThread(h.ID, ""); err == nil {
		t.Error("promoted a home thread")
	}

	// Reopening keeps the one Scratch project.
	s.Close()
	s, err = Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	projects, _ := s.ListProjects()
	n := 0
	for _, p := range projects {
		if p.IsScratch {
			n++
		}
	}
	if n != 1 {
		t.Errorf("%d Scratch projects after reopening", n)
	}
}

func TestThreadDone(t *testing.T) {
	s := open(t)
	p, err := s.CreateProject(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	th, err := s.CreateThread(p.ID, "", protocol.ThreadClaude)
	if err != nil {
		t.Fatal(err)
	}
	tab, err := s.CreateTab(th.ID, protocol.ThreadClaude, "")
	if err != nil {
		t.Fatal(err)
	}
	// A tab's agent marks the thread it belongs to.
	if err := s.SetThreadDone(tab.ID, true); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetThread(th.ID); got.DoneAt == nil {
		t.Fatal("the thread isn't done")
	}
	// Working in it again reopens it.
	if err := s.TouchThread(tab.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetThread(th.ID); got.DoneAt != nil {
		t.Fatal("touching the thread left it done")
	}
	if err := s.SetThreadDone("nope", true); err == nil {
		t.Fatal("marked a missing thread done")
	}
}

func TestPluginKV(t *testing.T) {
	s := open(t)
	if err := s.KVSet("notes", "thread:t1", "text", json.RawMessage(`"hi"`)); err != nil {
		t.Fatal(err)
	}
	if err := s.KVSet("notes", "", "count", json.RawMessage(`3`)); err != nil {
		t.Fatal(err)
	}
	if err := s.KVSet("other", "thread:t1", "text", json.RawMessage(`"theirs"`)); err != nil {
		t.Fatal(err)
	}
	v, ok, err := s.KVGet("notes", "thread:t1", "text")
	if err != nil || !ok || string(v) != `"hi"` {
		t.Fatalf("get = %s %v %v", v, ok, err)
	}
	for _, bad := range []struct{ scope, key, value string }{
		{"thread:t1", "", `1`}, {"nowhere", "k", `1`}, {"", "k", `not json`},
	} {
		if err := s.KVSet("notes", bad.scope, bad.key, json.RawMessage(bad.value)); err == nil {
			t.Errorf("set %+v accepted", bad)
		}
	}
	if list, _ := s.KVList("notes", "thread:t1", "", 0); len(list) != 1 || list[0].Key != "text" {
		t.Errorf("list = %+v", list)
	}
	if scopes, _ := s.KVScopes("notes", "thread:"); len(scopes) != 1 || scopes[0] != "thread:t1" {
		t.Errorf("scopes = %v", scopes)
	}
	// A thread's state goes with it, every plugin's.
	if err := s.KVDeleteScope("thread:t1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.KVGet("other", "thread:t1", "text"); ok {
		t.Error("thread state survived")
	}
	if _, ok, _ := s.KVGet("notes", "", "count"); !ok {
		t.Error("plugin-wide state went too")
	}
	if err := s.KVSet("notes", "", "big", json.RawMessage(`"`+strings.Repeat("x", KVMaxValue)+`"`)); err == nil {
		t.Error("oversized value accepted")
	}
}
