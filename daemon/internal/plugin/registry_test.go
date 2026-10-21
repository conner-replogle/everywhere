package plugin_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/pion/webrtc/v4"

	"github.com/conner-replogle/everywhere/daemon/internal/mcp"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin"
	"github.com/conner-replogle/everywhere/daemon/internal/plugin/plugintest"
)

// fake is a plugin built from functions.
type fake struct {
	m     plugin.Manifest
	start func(h plugin.Host) error
	order *[]string
}

func (f *fake) Manifest() plugin.Manifest { return f.m }
func (f *fake) Start(h plugin.Host) error {
	if f.order != nil {
		*f.order = append(*f.order, f.m.ID)
	}
	if f.start != nil {
		return f.start(h)
	}
	return nil
}
func (f *fake) Stop() {}

func mk(id string, order *[]string, requires, optional []string, start func(plugin.Host) error) *fake {
	return &fake{m: plugin.Manifest{ID: id, API: plugin.API, Requires: requires, Optional: optional}, start: start, order: order}
}

func TestStartOrder(t *testing.T) {
	var order []string
	r, _ := plugintest.Start(t,
		mk("c", &order, []string{"b"}, nil, nil),
		mk("b", &order, nil, []string{"a", "missing"}, nil),
		mk("a", &order, nil, nil, nil),
		mk("needs-missing", &order, []string{"missing"}, nil, nil),
		mk("fails", &order, nil, nil, func(h plugin.Host) error {
			h.HandleRPC("fails.x", func(context.Context, plugin.RPCContext, json.RawMessage) (any, error) { return 1, nil })
			return errors.New("no")
		}),
		mk("needs-failed", &order, []string{"fails"}, nil, nil),
		&fake{m: plugin.Manifest{ID: "old", API: plugin.API + 1}, order: &order},
	)
	if got := strings.Join(order, ","); got != "a,b,c,fails" {
		t.Errorf("started %s", got)
	}
	if r.Started("fails") || r.Started("needs-failed") || r.Started("needs-missing") || r.Started("old") {
		t.Error("a plugin that shouldn't run is running")
	}
	// What a failed plugin registered is gone.
	if _, err := r.Call(context.Background(), "fails.x", plugin.RPCContext{}, nil); err == nil {
		t.Error("failed plugin's method still served")
	}
}

func TestRPCAccess(t *testing.T) {
	ok := func(context.Context, plugin.RPCContext, json.RawMessage) (any, error) { return "ok", nil }
	r, _ := plugintest.Start(t, mk("p", nil, nil, nil, func(h plugin.Host) error {
		h.HandleRPC("p.local", ok)
		h.HandleRPC("p.remote", ok, plugin.Remote())
		h.HandleRPC("p.hubOnly", ok, plugin.RemoteOnly())
		h.HandleRPC("p.slow", ok, plugin.Slow())
		h.HandleRPC("p.panics", func(context.Context, plugin.RPCContext, json.RawMessage) (any, error) { panic("boom") })
		return nil
	}), mk("q", nil, nil, nil, func(h plugin.Host) error {
		// Another plugin can't take a method over.
		h.HandleRPC("p.local", func(context.Context, plugin.RPCContext, json.RawMessage) (any, error) { return "q", nil })
		return nil
	}))
	ctx := context.Background()
	for _, c := range []struct {
		method string
		remote bool
		ok     bool
	}{
		{"p.local", false, true}, {"p.local", true, false},
		{"p.remote", false, true}, {"p.remote", true, true},
		{"p.hubOnly", false, false}, {"p.hubOnly", true, true},
		{"nope", false, false},
	} {
		res, err := r.Call(ctx, c.method, plugin.RPCContext{Remote: c.remote}, nil)
		if (err == nil) != c.ok || (c.ok && res != "ok") {
			t.Errorf("%s remote=%v: %v %v", c.method, c.remote, res, err)
		}
	}
	if !r.Slow("p.slow") || r.Slow("p.local") {
		t.Error("slow flags")
	}
	if _, err := r.Call(ctx, "p.panics", plugin.RPCContext{}, nil); err == nil || !strings.Contains(err.Error(), "internal error") {
		t.Errorf("panic: %v", err)
	}
}

func TestChannelPrefixes(t *testing.T) {
	var got []string
	fn := func(name string) plugin.ChannelFunc {
		return func(_ context.Context, c plugin.ChannelContext, _ *webrtc.DataChannel) {
			got = append(got, name+":"+c.Rest)
		}
	}
	r, _ := plugintest.Start(t, mk("p", nil, nil, nil, func(h plugin.Host) error {
		h.HandleChannel("p/", fn("short"))
		h.HandleChannel("p/long/", fn("long"))
		return nil
	}))
	for _, label := range []string{"p/x", "p/long/y", "other"} {
		if f, rest, ok := r.Channel(label); ok {
			f(context.Background(), plugin.ChannelContext{Rest: rest}, nil)
		}
	}
	if strings.Join(got, ",") != "short:x,long:y" {
		t.Errorf("got %v", got)
	}
}

type fakePeer struct {
	id   string
	mu   sync.Mutex
	sent []any
}

func (p *fakePeer) ID() string     { return p.id }
func (p *fakePeer) Client() string { return "conn-" + p.id }
func (p *fakePeer) Send(e any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sent = append(p.sent, e)
}

func TestSessions(t *testing.T) {
	var mu sync.Mutex
	closed := map[string]int{}
	var cands []string
	r, _ := plugintest.Start(t, mk("media", nil, nil, nil, func(h plugin.Host) error {
		h.HandleSession("video", plugin.SessionHandler{
			Single: true,
			Open: func(_ context.Context, s plugin.Session, offer string, params json.RawMessage) (string, error) {
				if offer == "bad" {
					return "", errors.New("bad offer")
				}
				s.SendCandidate(webrtc.ICECandidateInit{Candidate: "c1"})
				return "answer:" + offer, nil
			},
			Candidate: func(s plugin.Session, c webrtc.ICECandidateInit) {
				mu.Lock()
				cands = append(cands, c.Candidate)
				mu.Unlock()
			},
			Closed: func(s plugin.Session) {
				mu.Lock()
				closed[s.ID()]++
				mu.Unlock()
			},
		})
		return nil
	}))
	ctx := context.Background()
	open := func(p *fakePeer, offer string) (string, error) {
		raw, _ := json.Marshal(map[string]any{"kind": "video", "sdp": offer})
		res, err := r.Call(ctx, "rtc.open", plugin.RPCContext{Peer: p}, raw)
		if err != nil {
			return "", err
		}
		b, _ := json.Marshal(res)
		var out struct{ ID, SDP string }
		_ = json.Unmarshal(b, &out)
		if out.SDP != "answer:"+offer {
			t.Errorf("answer %q", out.SDP)
		}
		return out.ID, nil
	}
	a, b := &fakePeer{id: "a"}, &fakePeer{id: "b"}

	if _, err := r.Call(ctx, "rtc.open", plugin.RPCContext{Remote: true}, json.RawMessage(`{"kind":"video","sdp":"x"}`)); err == nil {
		t.Error("rtc.open over the hub")
	}
	if _, err := open(a, "bad"); err == nil {
		t.Error("bad offer opened")
	}
	id1, err := open(a, "o1")
	if err != nil {
		t.Fatal(err)
	}
	if len(a.sent) != 1 {
		t.Fatalf("candidate not trickled: %v", a.sent)
	}
	// Only the opener can add candidates.
	raw, _ := json.Marshal(map[string]any{"id": id1, "candidate": map[string]any{"candidate": "x"}})
	_, _ = r.Call(ctx, "rtc.candidate", plugin.RPCContext{Peer: b}, raw)
	_, _ = r.Call(ctx, "rtc.candidate", plugin.RPCContext{Peer: a}, raw)
	if len(cands) != 1 {
		t.Errorf("candidates %v", cands)
	}
	// Single: b's session takes over, and a hears it closed.
	id2, err := open(b, "o2")
	if err != nil {
		t.Fatal(err)
	}
	if closed[id1] != 1 || len(a.sent) != 2 {
		t.Errorf("takeover: closed %v, a got %v", closed, a.sent)
	}
	// The peer going away ends its sessions, once.
	r.PeerClosed(b)
	r.PeerClosed(b)
	if closed[id2] != 1 {
		t.Errorf("peer close: %v", closed)
	}
}

func TestBus(t *testing.T) {
	b := plugin.NewBus()
	topic := plugin.Topic[int]{Name: "n"}
	var got []int
	plugin.Subscribe(b, topic, func(int) { panic("first handler") })
	plugin.Subscribe(b, topic, func(v int) { got = append(got, v) })
	var raw []string
	b.SubscribeRaw(func(name string, p json.RawMessage) { raw = append(raw, name+"="+string(p)) })
	plugin.Publish(b, topic, 7)
	if len(got) != 1 || got[0] != 7 || len(raw) != 1 || raw[0] != "n=7" {
		t.Errorf("got %v raw %v", got, raw)
	}
}

func TestAgentContributions(t *testing.T) {
	r, _ := plugintest.Start(t,
		mk("a", nil, nil, nil, func(h plugin.Host) error {
			h.ContributeAgent(func(l plugin.AgentLaunch) plugin.AgentContribution {
				return plugin.AgentContribution{SystemPrompt: []string{"a:" + l.ThreadID}, Env: map[string]string{"A": "1"}}
			})
			h.AddTools(plugin.Tool{Tool: mcpTool("safe")}, plugin.Tool{Tool: mcpTool("asks"), Ask: true})
			return nil
		}),
		mk("b", nil, nil, nil, func(h plugin.Host) error {
			h.ContributeAgent(func(plugin.AgentLaunch) plugin.AgentContribution { panic("bad plugin") })
			return nil
		}),
	)
	c := r.AgentContributions(plugin.AgentLaunch{ThreadID: "t"})
	if len(c.SystemPrompt) != 1 || c.SystemPrompt[0] != "a:t" || c.Env["A"] != "1" {
		t.Errorf("contribution %+v", c)
	}
	if got := strings.Join(r.Allowed(), ","); got != "mcp__everywhere__safe" {
		t.Errorf("allowed %s", got)
	}
}

func mcpTool(name string) mcp.Tool {
	return mcp.Tool{Name: name, InputSchema: json.RawMessage(`{"type":"object"}`)}
}
