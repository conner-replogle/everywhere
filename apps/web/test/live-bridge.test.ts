import { describe, expect, test } from "bun:test";
import { LiveBridge, type LiveEvent } from "../src/lib/assistant/live-bridge";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const sent: LiveEvent[] = [];
  const asked: string[] = [];
  const bridge = new LiveBridge({ ask: (t) => asked.push(t) }, { send: (e) => sent.push(e) });
  const hear = (...parts: string[]) => {
    for (const delta of parts) bridge.handle({ type: "session.input_transcript.delta", delta });
  };
  const delegate = (id: string) => bridge.handle({ type: "session.delegation.created", delegation: { id, type: "delegation", target: "client" } });
  return { bridge, sent, asked, hear, delegate };
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
});
