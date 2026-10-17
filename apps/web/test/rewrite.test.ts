import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@everywhere/protocol";
import type { LoggedEvent } from "../src/lib/agent";
import { rewriteContext } from "../src/lib/rewrite";

const log = (events: AgentEvent[]): LoggedEvent[] => events.map((event, i) => ({ seq: i + 1, at: 0, event }));

describe("rewriteContext", () => {
  test("keeps prompts and replies, drops tools, thinking and subagents", () => {
    const ctx = rewriteContext(
      log([
        { type: "user", id: "u1", text: "fix the login bug" },
        { type: "thinking", id: "t1", text: "hmm" },
        { type: "tool", id: "x1", name: "Bash", input: { command: "ls" } },
        { type: "toolResult", id: "x1", output: "src" },
        { type: "assistant", id: "a0", text: "subagent says hi", parentId: "x1" },
        { type: "assistant", id: "a1", text: "Fixed it in auth.ts." },
        { type: "user", id: "u2", attachments: [] },
      ]),
    );
    expect(ctx).toEqual([
      { role: "user", text: "fix the login bug" },
      { role: "claude", text: "Fixed it in auth.ts." },
    ]);
  });

  test("keeps only the newest messages once over the limit", () => {
    const big = "x".repeat(15_000);
    const ctx = rewriteContext(
      log([
        { type: "user", id: "u1", text: "oldest" },
        { type: "assistant", id: "a1", text: big },
        { type: "user", id: "u2", text: big },
      ]),
    );
    expect(ctx.map((m) => m.role)).toEqual(["claude", "user"]);
  });
});
