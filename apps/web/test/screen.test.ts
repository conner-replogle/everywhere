import { describe, expect, test } from "bun:test";
import type { AssistantEntry } from "@everywhere/protocol";
import { cardId, screenCards, screenNote, withWriting } from "../src/lib/assistant/screen";

let seq = 0;
const at = (message: unknown): AssistantEntry => ({ kind: "message", message, seq: ++seq, at: 0 });
const user = (text: string) => at({ role: "user", content: text, timestamp: 0 });
const calls = (...c: { id: string; name: string; arguments: Record<string, unknown> }[]) =>
  at({ role: "assistant", content: c.map((x) => ({ type: "toolCall", ...x })), stopReason: "toolUse", timestamp: 0 });
const show = (id: string, markdown: string, callId = `c${seq}`) => calls({ id: callId, name: "show_on_screen", arguments: { id, markdown } });
const clear = (id?: string) => calls({ id: `c${seq}`, name: "clear_screen", arguments: id ? { id } : {} });
const failedResult = (callId: string) =>
  at({ role: "toolResult", toolCallId: callId, toolName: "show_on_screen", content: [], isError: true, timestamp: 0 });

describe("screenCards", () => {
  test("showing the same id again updates it in place; newest first", () => {
    const cards = screenCards([user("q"), show("decisions", "# Decisions\nReading…"), show("todo", "- [ ] a"), show("Decisions", "# Decisions\n1. x")]);
    expect(cards.map((c) => [c.id, c.markdown])).toEqual([
      ["decisions", "# Decisions\n1. x"],
      ["todo", "- [ ] a"],
    ]);
  });

  test("a card lasts through the next turn and goes when one passes without it", () => {
    const log = [user("q1"), show("recap", "# Recap")];
    expect(screenCards(log).length).toBe(1);
    log.push(user("q2"));
    expect(screenCards(log).length).toBe(1);
    log.push(user("q3"));
    expect(screenCards(log)).toEqual([]);
  });

  test("touching it keeps it", () => {
    const log = [user("q1"), show("recap", "# Recap"), user("q2"), show("recap", "# Recap 2"), user("q3")];
    expect(screenCards(log).map((c) => c.markdown)).toEqual(["# Recap 2"]);
  });

  test("clear takes one card or all of them", () => {
    expect(screenCards([user("q"), show("a", "A"), show("b", "B"), clear("a")]).map((c) => c.id)).toEqual(["b"]);
    expect(screenCards([user("q"), show("a", "A"), show("b", "B"), clear()])).toEqual([]);
  });

  test("a call that failed shows nothing", () => {
    const log = [user("q"), show("big", "x".repeat(50), "call-big"), failedResult("call-big")];
    expect(screenCards(log)).toEqual([]);
  });

  test("at most three; the oldest go", () => {
    const cards = screenCards([user("q"), show("a", "A"), show("b", "B"), show("c", "C"), show("d", "D")]);
    expect(cards.map((c) => c.id)).toEqual(["d", "c", "b"]);
  });

  test("ids are tidied", () => {
    expect(cardId("Release Checklist!")).toBe("release-checklist");
    expect(cardId("")).toBe("card");
  });
});

test("the note names the cards shown this turn, which will still be up next turn", () => {
  const log = [user("q1"), show("old", "# Old one"), user("q2"), show("decisions", "## The **three** decisions\n- a")];
  const note = screenNote(log);
  expect(note).toContain("[decisions] The three decisions");
  expect(note).not.toContain("old");
  expect(screenNote([user("q")])).toBe("");
});

test("cards still being written replace theirs or come first", () => {
  const cards = screenCards([user("q"), show("a", "A"), show("b", "B")]);
  const live = withWriting(cards, [{ id: "a", markdown: "A, rewriting" }, { id: "new", markdown: "Ne" }]);
  expect(live.map((c) => [c.id, c.markdown, c.seq === 0])).toEqual([
    ["new", "Ne", true],
    ["a", "A, rewriting", true],
    ["b", "B", false],
  ]);
  expect(withWriting(cards, undefined)).toBe(cards);
});
