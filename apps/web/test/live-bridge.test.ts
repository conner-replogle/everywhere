import { describe, expect, test } from "bun:test";
import { LiveBridge, type LiveEvent } from "../src/lib/assistant/live-bridge";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const sent: LiveEvent[] = [];
  const asked: string[] = [];
  const answered: [string, string][] = [];
  const bridge = new LiveBridge(
    { ask: (t) => asked.push(t) },
    { send: (e) => sent.push(e), onAnswered: (said, reply) => answered.push([said, reply]) },
  );
  const hear = (...parts: string[]) => {
    for (const delta of parts) bridge.handle({ type: "session.input_transcript.delta", delta });
  };
  const delegate = (id: string) => bridge.handle({ type: "session.delegation.created", delegation: { id, type: "delegation", target: "client" } });
  /** Speech placed on the session's timeline, as GPT-Live sends it. */
  const you = (delta: string, start_ms: number, end_ms: number) =>
    bridge.handle({ type: "session.input_transcript.delta", delta, start_ms, end_ms });
  const it = (delta: string, start_ms: number, end_ms: number) =>
    bridge.handle({ type: "session.output_transcript.delta", delta, start_ms, end_ms });
  const delegateAt = (id: string, offset_ms: number) =>
    bridge.handle({ type: "session.delegation.created", offset_ms, delegation: { id, type: "delegation", target: "client" } });
  return { bridge, sent, asked, answered, hear, delegate, you, it, delegateAt };
}

describe("LiveBridge", () => {
  test("a hand-off gives the agent what was said, once the transcript settles, and its replies go back to that hand-off", async () => {
    const t = setup();
    t.hear("What's running ");
    t.delegate("item_1");
    t.hear("on omarcherion?");
    expect(t.asked).toEqual([]);
    await wait(900);
    expect(t.asked).toEqual(["What's running on omarcherion?"]);
    t.bridge.assistantSaid("Two threads are working.");
    expect(t.sent.at(-1)).toMatchObject({ type: "session.commentary.append", delegation_id: "item_1", content: "Two threads are working." });
    t.bridge.turnEnded();
    t.bridge.assistantSaid("The api thread finished.");
    expect(t.sent.at(-1)).toMatchObject({ delegation_id: null });
    t.bridge.close();
  });

  test("a long reply goes back in pieces", () => {
    const t = setup();
    t.bridge.assistantSaid("x".repeat(4000));
    expect(t.sent.map((e) => (e.content as string).length)).toEqual([1500, 1500, 1000]);
  });

  test("a yes is the user's words like any others: it goes to the agent", async () => {
    const t = setup();
    t.hear("Yes.");
    t.delegate("item_2");
    await wait(500);
    expect(t.asked).toEqual(["Yes."]);
    t.bridge.close();
  });

  test("a hand-off with nothing heard is answered quietly", async () => {
    const t = setup();
    t.delegate("item_3");
    await wait(900);
    expect(t.asked).toEqual([]);
    expect(t.sent.at(-1)).toMatchObject({ type: "session.thinking.append", delegation_id: "item_3" });
    t.bridge.close();
  });
  test("a hand-off doesn't take along what GPT-Live already answered; that goes to the chat", async () => {
    const t = setup();
    t.you("How's it going?", 0, 800);
    t.it("Pretty good, thanks!", 1000, 1600);
    t.you("What's running on omarcherion?", 3000, 4500);
    t.it("Let me check.", 4700, 5200);
    t.delegateAt("item_5", 4900);
    await wait(500);
    expect(t.asked).toEqual(["What's running on omarcherion?"]);
    expect(t.answered).toEqual([["How's it going?", "Pretty good, thanks!"]]);
    t.bridge.close();
    // "Let me check." belonged to the hand-off: nothing more is logged.
    expect(t.answered).toHaveLength(1);
  });

  test("what GPT-Live answers with no hand-off is logged once it's had its say", () => {
    const t = setup();
    t.you("What's a good name for a cat?", 0, 1200);
    t.it("How about Miso?", 1500, 2400);
    t.bridge.close();
    expect(t.answered).toEqual([["What's a good name for a cat?", "How about Miso?"]]);
    expect(t.asked).toEqual([]);
  });

  test("a note tells GPT-Live something quietly, outside any hand-off", () => {
    const t = setup();
    t.bridge.note("Meanwhile the user typed in the chat: rename the thread");
    expect(t.sent.at(-1)).toMatchObject({ type: "session.thinking.append", delegation_id: null, content: "Meanwhile the user typed in the chat: rename the thread" });
  });
});
