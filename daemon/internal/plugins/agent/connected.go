package agent

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/conner-replogle/everywhere/daemon/internal/agent"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// Connected agents (MCP clients the account authorized, relayed by the
// Worker over the hub) read and drive agent threads with these. They're
// registered with plugin.Agent, so they answer only while the device allows
// connected agents. What's left out is on purpose: answering permission
// prompts, rewinding, and anything that runs commands or reads files
// outside a thread's own attachments.

const (
	readEventsDefault = 200
	readEventsMax     = 1000
	readWaitMax       = 50 * time.Second
	// maxAgentFile bounds a file sent with agent.send or read with
	// agent.file: both travel base64 in one hub message.
	maxAgentFile = 8 << 20
	// maxAgentFiles bounds what one agent.send carries in all.
	maxAgentFiles = 16 << 20
)

// loggedEvent is one event of a thread's log.
type loggedEvent struct {
	Seq   int64           `json:"seq"`
	At    int64           `json:"at"`
	Event json.RawMessage `json:"event"`
}

// agentRead is what agent.read returns: an agent thread, its live state and
// a page of its log, oldest first.
type agentRead struct {
	Thread protocol.Thread     `json:"thread"`
	State  protocol.AgentState `json:"state"`
	Events []loggedEvent       `json:"events"`
	// More: there are older events before the first one here.
	More bool `json:"more"`
	// LastSeq is the newest event's seq (afterSeq's if none), for afterSeq next time.
	LastSeq int64 `json:"lastSeq"`
}

// agentFile is a file sent with agent.send.
type agentFile struct {
	Name      string `json:"name"`
	MediaType string `json:"mediaType"`
	// Data is the file, base64.
	Data string `json:"data"`
}

type connectedParams struct {
	ThreadID  string `json:"threadId"`
	AfterSeq  int64  `json:"afterSeq"`
	BeforeSeq int64  `json:"beforeSeq"`
	Limit     int    `json:"limit"`
	WaitMs    int64  `json:"waitMs"`
	// agent.send
	Text  string      `json:"text"`
	Files []agentFile `json:"files"`
	// agent.configure
	Model      *string `json:"model"`
	Mode       string  `json:"mode"`
	Effort     string  `json:"effort"`
	Thinking   *bool   `json:"thinking"`
	Workspace  string  `json:"workspace"`
	BaseBranch string  `json:"baseBranch"`
	// agent.file
	ID string `json:"id"`
}

func (p *Plugin) registerConnected(h plugin.Host) {
	rpc := func(method string, fn func(c plugin.RPCContext, ps connectedParams) (any, error), opts ...plugin.RPCOption) {
		h.HandleRPC(method, plugin.Params(fn), append(opts, plugin.Agent())...)
	}
	rpc("agent.read", p.connectedRead, plugin.Slow())
	rpc("agent.send", p.connectedSend, plugin.Slow())
	rpc("agent.interrupt", func(_ plugin.RPCContext, ps connectedParams) (any, error) {
		if _, err := p.agentThread(ps.ThreadID); err != nil {
			return nil, err
		}
		return plugin.Empty{}, p.m.Request(ps.ThreadID, protocol.AgentClientMsg{T: "interrupt"})
	})
	rpc("agent.configure", p.connectedConfigure, plugin.Slow())
	rpc("agent.file", func(_ plugin.RPCContext, ps connectedParams) (any, error) {
		if _, err := p.agentThread(ps.ThreadID); err != nil {
			return nil, err
		}
		att, data, err := p.m.ReadAttachment(ps.ThreadID, ps.ID, maxAgentFile)
		if err != nil {
			return nil, err
		}
		return struct {
			Attachment protocol.AgentAttachment `json:"attachment"`
			Data       string                   `json:"data"`
		}{att, base64.StdEncoding.EncodeToString(data)}, nil
	})
}

// agentThread is a thread of claude or another agent.
func (p *Plugin) agentThread(id string) (protocol.Thread, error) {
	t, err := p.h.Threads().Get(id)
	if err != nil {
		return t, err
	}
	if !agent.IsAgentKind(t.Kind) {
		return t, fmt.Errorf("%q is a %s thread, not an agent's", t.Name, t.Kind)
	}
	return t, nil
}

// connectedRead reads an agent thread: the newest limit events after
// afterSeq (and before beforeSeq, if set). With waitMs, it first waits up to
// that long for a turn in progress to finish or stop on a prompt.
func (p *Plugin) connectedRead(_ plugin.RPCContext, r connectedParams) (any, error) {
	t, err := p.agentThread(r.ThreadID)
	if err != nil {
		return nil, err
	}
	if wait := min(time.Duration(r.WaitMs)*time.Millisecond, readWaitMax); wait > 0 {
		deadline := time.Now().Add(wait)
		for time.Now().Before(deadline) {
			if _, status := p.m.Status(t.ID); status != "starting" && status != "working" {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	limit := r.Limit
	if limit <= 0 {
		limit = readEventsDefault
	}
	events, more, err := p.h.Store().AgentEvents(t.ID, r.AfterSeq, r.BeforeSeq, min(limit, readEventsMax))
	if err != nil {
		return nil, err
	}
	st, err := p.m.State(t.ID)
	if err != nil {
		return nil, err
	}
	// Every client gets these from device.info and agent.info instead.
	st.Models, st.Commands = nil, nil
	if live, err := p.h.Threads().Live(t.ID); err == nil {
		t = live
	}
	out := agentRead{Thread: t, State: st, Events: make([]loggedEvent, len(events)), More: more, LastSeq: r.AfterSeq}
	for i, e := range events {
		out.Events[i] = loggedEvent{Seq: e.Seq, At: e.At, Event: e.Event}
		out.LastSeq = max(out.LastSeq, e.Seq)
	}
	return out, nil
}

// connectedSend sends a prompt, with files, marked as the agent's.
func (p *Plugin) connectedSend(c plugin.RPCContext, r connectedParams) (any, error) {
	t, err := p.agentThread(r.ThreadID)
	if err != nil {
		return nil, err
	}
	if t.ArchivedAt != nil {
		return nil, errors.New("this thread is archived; restore it first")
	}
	if strings.TrimSpace(r.Text) == "" && len(r.Files) == 0 {
		return nil, errors.New("send text, files or both")
	}
	var ids []string
	total := 0
	for _, f := range r.Files {
		data, err := base64.StdEncoding.DecodeString(f.Data)
		if err != nil {
			return nil, fmt.Errorf("%s isn't valid base64: %w", f.Name, err)
		}
		if len(data) > maxAgentFile {
			return nil, fmt.Errorf("%s is %d MB; the limit is %d MB a file", f.Name, len(data)>>20, maxAgentFile>>20)
		}
		if total += len(data); total > maxAgentFiles {
			return nil, fmt.Errorf("the files are over %d MB in all", maxAgentFiles>>20)
		}
		mediaType := strings.TrimSpace(f.MediaType)
		if mediaType == "" {
			mediaType = "application/octet-stream"
		}
		id := agent.NewUploadID()
		if _, err := p.m.SaveUpload(t.ID, id, f.Name, mediaType, int64(len(data)), bytes.NewReader(data)); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	err = p.m.Request(t.ID, protocol.AgentClientMsg{T: "send", Text: r.Text, Attachments: ids, Via: c.Agent})
	if err != nil {
		return nil, err
	}
	return plugin.Empty{}, nil
}

// connectedConfigure changes an agent thread's settings, except to a mode
// that skips permission prompts.
func (p *Plugin) connectedConfigure(c plugin.RPCContext, r connectedParams) (any, error) {
	if _, err := p.agentThread(r.ThreadID); err != nil {
		return nil, err
	}
	if c.Agent != "" && r.Mode == "bypassPermissions" {
		return nil, errors.New("connected agents can't turn off permission prompts")
	}
	var msgs []protocol.AgentClientMsg
	if r.Workspace != "" {
		msgs = append(msgs, protocol.AgentClientMsg{T: "setWorkspace", Workspace: r.Workspace, BaseBranch: r.BaseBranch})
	}
	if r.Model != nil {
		msgs = append(msgs, protocol.AgentClientMsg{T: "setModel", Model: *r.Model})
	}
	if r.Mode != "" {
		msgs = append(msgs, protocol.AgentClientMsg{T: "setMode", Mode: r.Mode})
	}
	if r.Effort != "" {
		msgs = append(msgs, protocol.AgentClientMsg{T: "setEffort", Effort: r.Effort})
	}
	if r.Thinking != nil {
		msgs = append(msgs, protocol.AgentClientMsg{T: "setThinking", Thinking: r.Thinking})
	}
	for _, m := range msgs {
		if err := p.m.Request(r.ThreadID, m); err != nil {
			return nil, fmt.Errorf("%s: %w", m.T, err)
		}
	}
	st, err := p.m.State(r.ThreadID)
	if err != nil {
		return nil, err
	}
	st.Models, st.Commands = nil, nil
	return st, nil
}
