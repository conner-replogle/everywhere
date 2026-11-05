import { describe, expect, test } from "bun:test";
import type { AssistantApproval } from "@everywhere/protocol";
import { LiveBridge, type LiveEvent } from "../src/lib/assistant/live-bridge";
import { approvalAnswer } from "../src/lib/assistant/messages";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const sent: LiveEvent[] = [];
  const asked: string[] = [];
  const answers: [string, boolean][] = [];
  let approvals: AssistantApproval[] = [];
  const bridge = new LiveBridge(
    {
      ask: (t) => asked.push(t),
      approvals: () => approvals,
      answer: (id, allow) => {
        answers.push([id, allow]);
        approvals = approvals.filter((a) => a.id !== id);
      },
    },
    { send: (e) => sent.push(e) },
  );
  const hear = (...parts: string[]) => {
    for (const delta of parts) bridge.handle({ type: "session.input_transcript.delta", delta });
  };
  const delegate = (id: string) => bridge.handle({ type: "session.delegation.created", delegation: { id, type: "delegation", target: "client" } });
  return { bridge, sent, asked, answers, hear, delegate, setApprovals: (a: AssistantApproval[]) => (approvals = a) };
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

  test("yes answers the waiting approval, and the hand-off for it is quiet", async () => {
    const t = setup();
    t.setApprovals([{ id: "a1", title: "Send to fix flaky test", detail: "Run the tests again" }]);
    t.bridge.approvalAdded({ id: "a1", title: "Send to fix flaky test", detail: "Run the tests again" });
    expect(t.sent.at(-1)?.content).toContain("Send to fix flaky test?");
    t.hear("Yes, go ahead.");
    await wait(1000);
    expect(t.answers).toEqual([["a1", true]]);
    t.delegate("item_2");
    await wait(800);
    expect(t.asked).toEqual([]);
    expect(t.sent.at(-1)).toMatchObject({ type: "session.thinking.append", delegation_id: "item_2" });
    t.bridge.close();
  });

  test("a yes whose hand-off comes before the words count as finished still allows it", async () => {
    const t = setup();
    t.setApprovals([{ id: "a1", title: "Send to fix flaky test" }]);
    t.hear("Uh, yes.");
    t.delegate("item_4");
    await wait(500);
    expect(t.answers).toEqual([["a1", true]]);
    expect(t.asked).toEqual([]);
    expect(t.sent.at(-1)).toMatchObject({ type: "session.thinking.append", delegation_id: "item_4" });
    await wait(1000);
    expect(t.answers).toEqual([["a1", true]]);
    t.bridge.close();
  });

  test("approval answers", () => {
    for (const yes of ["Yes.", "yeah go ahead", "Allow it", "Okay, send it.", "Uh, yes please", "Sounds good", "go for it"]) expect(approvalAnswer(yes)).toBe(true);
    for (const no of ["No.", "Nope", "Don't send that", "um, no", "Wait, hold on"]) expect(approvalAnswer(no)).toBe(false);
    for (const other of ["Check the web thread first", "Please check the logs", "What would it send?"]) expect(approvalAnswer(other)).toBe(null);
  });

  test("anything else while an approval waits denies it and becomes the request", async () => {
    const t = setup();
    t.setApprovals([{ id: "a1", title: "Start a thread" }]);
    t.hear("Actually, check the web thread first.");
    t.delegate("item_3");
    await wait(1000);
    expect(t.answers).toEqual([["a1", false]]);
    expect(t.asked).toEqual(["Actually, check the web thread first."]);
    t.bridge.close();
  });
});
