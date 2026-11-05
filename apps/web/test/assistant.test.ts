import { describe, expect, test } from "bun:test";
import type { AssistantEntry } from "@everywhere/protocol";
import { contextFrom, messageText, speakable, spokenPart } from "../src/lib/assistant/messages";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text: string) => ({ role: "user", content: text, timestamp: 0 });
const reply = (text: string, calls: { id: string; name: string }[] = [], stopReason = "stop") => ({
  role: "assistant",
  content: [...(text ? [{ type: "text", text }] : []), ...calls.map((c) => ({ type: "toolCall", ...c, arguments: {} }))],
  api: "openai-completions",
  provider: "workers-ai",
  model: "m",
  usage,
  stopReason,
  timestamp: 0,
});
const result = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "t", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0 });

function log(...items: ({ message: unknown } | { summary: string; throughSeq: number })[]): AssistantEntry[] {
  return items.map((x, i) =>
    "message" in x ? { kind: "message", message: x.message, seq: i + 1, at: 0 } : { kind: "compaction", ...x, seq: i + 1, at: 0 },
  );
}

describe("contextFrom", () => {
  test("is the messages in order when nothing was compacted", () => {
    const ctx = contextFrom(log({ message: user("hi") }, { message: reply("hello") }));
    expect(ctx.map((m) => messageText(m))).toEqual(["hi", "hello"]);
  });

  test("starts from the latest summary and leaves out what it covers", () => {
    const ctx = contextFrom(
      log(
        { message: user("old question") },
        { message: reply("old answer") },
        { message: user("kept question") },
        { summary: "first summary", throughSeq: 1 },
        { summary: "they asked an old question", throughSeq: 2 },
        { message: reply("kept answer") },
      ),
    );
    const texts = ctx.map((m) => messageText(m));
    expect(texts[0]).toContain("they asked an old question");
    expect(texts.join("|")).not.toContain("old answer");
    expect(texts.slice(2)).toEqual(["kept question", "kept answer"]);
  });

  test("answers tool calls whose results never came, and drops failed empty replies", () => {
    const ctx = contextFrom(
      log(
        { message: user("do two things") },
        { message: reply("", [{ id: "a", name: "t" }, { id: "b", name: "t" }]) },
        { message: result("a") },
        { message: reply("", [], "error") },
        { message: user("again") },
      ),
    );
    expect(ctx.map((m) => (m as { role: string }).role)).toEqual(["user", "assistant", "toolResult", "toolResult", "user"]);
    const results = ctx.slice(2, 4) as { toolCallId: string; isError: boolean }[];
    expect(results.map((r) => r.toolCallId).sort()).toEqual(["a", "b"]);
    expect(results.find((r) => r.toolCallId === "b")?.isError).toBe(true);
  });
});

test("spokenPart drops the context note", () => {
  expect(spokenPart("what's running?\n\n<context>The user is looking at the home page.</context>")).toBe("what's running?");
  expect(spokenPart("plain")).toBe("plain");
});

test("speakable reads markdown as plain speech", () => {
  expect(speakable("**Two** threads: see [the api](https://x.dev/a) and `web`.\n```sh\nls\n```\nDone.")).toBe(
    "Two threads: see the api and web. Done.",
  );
});

describe("transcriptPages", () => {
  const ev = (type: "user" | "assistant", id: string, text: string) => ({ type, id, text });

  test("has only prompts and replies, whole, newest page first", async () => {
    const { transcriptPages } = await import("../src/lib/assistant/tools");
    const pages = transcriptPages(
      [
        ev("user", "u1", "first question"),
        { type: "tool", id: "t1", name: "Read", input: { file_path: "/src/app.ts" } },
        { type: "toolResult", id: "t1", output: "secret file contents" },
        ev("assistant", "a1", "a".repeat(60)),
        { type: "turn", status: "completed" },
        ev("user", "u2", "second question"),
        ev("assistant", "a2", "b".repeat(60)),
      ],
      120,
    );
    expect(pages).toEqual([`USER: second question\n\nCLAUDE: ${"b".repeat(60)}`, `USER: first question\n\nCLAUDE: ${"a".repeat(60)}`]);
  });

  test("splits a reply too long for a page into parts, losing nothing", async () => {
    const { transcriptPages } = await import("../src/lib/assistant/tools");
    const long = `${"x".repeat(250)}THE END`;
    const pages = transcriptPages([ev("user", "u1", "plan it"), ev("assistant", "a1", long)], 140);
    for (const p of pages) expect(p.length).toBeLessThanOrEqual(140);
    expect(pages[0]).toContain("of 3): ");
    expect(pages[0]).toContain("THE END");
    expect(pages.at(-1)).toStartWith("USER: plan it");
    const text = [...pages].reverse().join("").replace(/USER: plan it\n\n|CLAUDE \(part \d of \d\): /g, "");
    expect(text).toBe(long);
  });
});
