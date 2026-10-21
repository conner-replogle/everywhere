// Package acptest is a fake ACP agent for tests: a test binary runs it
// instead of its tests when Env is set (call Main from TestMain), and an
// Agent whose command is the test binary talks to it.
package acptest

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
	"sync"
)

// Env, set to "1", makes Main run the fake agent.
const Env = "FAKE_ACP_AGENT"

// Main runs the fake agent and exits if Env is set; otherwise it returns.
//
// The agent answers initialize, session/new and session/load (session
// "s1"; a load replays one message, which a client must ignore), offers
// models m1/m2 and modes build/plan, and runs each prompt as: a thought,
// text, a write of the file the prompt names after "write " (asking
// permission first), then text, usage and end_turn. A prompt containing
// "slow" waits to be cancelled. Prompts with images say so in the text.
func Main() {
	if os.Getenv(Env) != "1" {
		return
	}
	run()
	os.Exit(0)
}

func run() {
	out := bufio.NewWriter(os.Stdout)
	var wmu sync.Mutex
	send := func(m map[string]any) {
		m["jsonrpc"] = "2.0"
		b, _ := json.Marshal(m)
		wmu.Lock()
		out.Write(append(b, '\n'))
		out.Flush()
		wmu.Unlock()
	}
	update := func(u map[string]any) {
		send(map[string]any{"method": "session/update", "params": map[string]any{"sessionId": "s1", "update": u}})
	}
	text := func(kind, s string) {
		update(map[string]any{"sessionUpdate": kind, "content": map[string]any{"type": "text", "text": s}})
	}
	var rmu sync.Mutex
	replies := map[float64]chan json.RawMessage{}
	cancel := make(chan struct{}, 1)
	nextID := 9000.0
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1<<20), 8<<20)
	for in.Scan() {
		var m struct {
			ID     *float64        `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
		}
		if json.Unmarshal(in.Bytes(), &m) != nil {
			continue
		}
		if m.Method == "" && m.ID != nil {
			rmu.Lock()
			ch := replies[*m.ID]
			rmu.Unlock()
			if ch != nil {
				ch <- m.Result
			}
			continue
		}
		config := []any{
			map[string]any{"id": "model", "category": "model", "type": "select", "currentValue": "m1",
				"options": []any{map[string]any{"value": "m1", "name": "Model One"}, map[string]any{"value": "m2", "name": "Model Two"}}},
			map[string]any{"id": "mode", "category": "mode", "type": "select", "currentValue": "build",
				"options": []any{map[string]any{"value": "build", "name": "Build"}, map[string]any{"value": "plan", "name": "Plan"}}},
		}
		switch m.Method {
		case "initialize":
			send(map[string]any{"id": *m.ID, "result": map[string]any{
				"protocolVersion": 1,
				"agentCapabilities": map[string]any{
					"loadSession": true, "promptCapabilities": map[string]any{"image": true},
					"mcpCapabilities": map[string]any{"http": true},
				},
				"agentInfo": map[string]any{"name": "fake", "version": "9.9"},
			}})
		case "session/new":
			send(map[string]any{"id": *m.ID, "result": map[string]any{"sessionId": "s1", "configOptions": config}})
		case "session/load":
			text("agent_message_chunk", "replayed from before")
			send(map[string]any{"id": *m.ID, "result": map[string]any{"configOptions": config}})
		case "session/set_config_option":
			send(map[string]any{"id": *m.ID, "result": map[string]any{}})
		case "session/cancel":
			select {
			case cancel <- struct{}{}:
			default:
			}
		case "session/prompt":
			id := *m.ID
			var p struct {
				Prompt []struct {
					Type     string `json:"type"`
					Text     string `json:"text"`
					MimeType string `json:"mimeType"`
				} `json:"prompt"`
			}
			json.Unmarshal(m.Params, &p)
			var words []string
			images := 0
			for _, b := range p.Prompt {
				if b.Type == "image" {
					images++
				}
				words = append(words, b.Text)
			}
			prompt := strings.Join(words, " ")
			go func() {
				if strings.Contains(prompt, "slow") {
					text("agent_message_chunk", "Working on it")
					<-cancel
					send(map[string]any{"id": id, "result": map[string]any{"stopReason": "cancelled"}})
					return
				}
				text("agent_thought_chunk", "thinking it over")
				reply := "I'll write the file."
				if images > 0 {
					reply = "I see an image. " + reply
				}
				text("agent_message_chunk", reply[:5])
				text("agent_message_chunk", reply[5:])
				file := "a.txt"
				if _, after, ok := strings.Cut(prompt, "write "); ok {
					file = strings.Fields(after)[0]
				}
				update(map[string]any{"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "write", "kind": "edit", "status": "pending", "rawInput": map[string]any{}})
				rmu.Lock()
				nextID++
				rid := nextID
				ch := make(chan json.RawMessage, 1)
				replies[rid] = ch
				rmu.Unlock()
				send(map[string]any{"id": rid, "method": "session/request_permission", "params": map[string]any{
					"sessionId": "s1",
					"toolCall":  map[string]any{"toolCallId": "t1", "title": "write", "kind": "edit", "rawInput": map[string]any{"filePath": file, "content": "hi"}},
					"options": []any{
						map[string]any{"optionId": "yes", "name": "Allow", "kind": "allow_once"},
						map[string]any{"optionId": "always", "name": "Always", "kind": "allow_always"},
						map[string]any{"optionId": "no", "name": "Reject", "kind": "reject_once"},
					},
				}})
				var res struct {
					Outcome struct{ Outcome, OptionID string } `json:"outcome"`
				}
				json.Unmarshal(<-ch, &res)
				status, out := "failed", "Rejected."
				if res.Outcome.OptionID == "yes" || res.Outcome.OptionID == "always" {
					status, out = "completed", "Wrote file successfully."
				}
				update(map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": status,
					"content": []any{map[string]any{"type": "content", "content": map[string]any{"type": "text", "text": out}}}})
				text("agent_message_chunk", "Done.")
				update(map[string]any{"sessionUpdate": "usage_update", "used": 50, "size": 1000})
				send(map[string]any{"id": id, "result": map[string]any{"stopReason": "end_turn"}})
			}()
		}
	}
}
