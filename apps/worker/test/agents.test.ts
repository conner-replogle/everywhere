import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@everywhere/protocol";
import type { AgentCaller } from "../src/agents/keys";
import { type ToolContext, tools } from "../src/agents/tools";

// A device whose daemon keeps a thread's log in memory and answers the agent
// methods the tools call, as the hub would relay them.
function fakeDevice(events: AgentEvent[], opts: { status?: string } = {}) {
  const log = events.map((event, i) => ({ seq: i + 1, at: 1000 + i, event }));
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const thread = { id: "t1", projectId: "p1", kind: "claude", name: "Fix the build", createdAt: 1, lastOpenedAt: 2, running: true, agentStatus: "idle" };
  const state = {
    status: opts.status ?? "idle",
    model: "",
    permissionMode: "default",
    pending: [],
    streaming: [],
    models: [],
    workspace: { mode: "local" },
  };
  const answer = (method: string, p: Record<string, unknown>): unknown => {
    switch (method) {
      case "threads.get":
        if (p.threadId !== "t1") throw new Error("no such thread");
        return thread;
      case "threads.list":
        return [thread];
      case "projects.list":
        return [{ id: "p1", name: "app", path: "/src/app", isHome: false, createdAt: 1 }];
      case "agent.read": {
        const after = Number(p.afterSeq ?? 0);
        const before = p.beforeSeq ? Number(p.beforeSeq) : Infinity;
        const limit = Number(p.limit ?? 200);
        const match = log.filter((e) => e.seq > after && e.seq < before);
        const page = match.slice(-limit);
        return { thread, state, events: page, more: match.length > page.length, lastSeq: page.at(-1)?.seq ?? after };
      }
      case "agent.send": {
        const files = (p.files as { name: string }[] | undefined) ?? [];
        log.push({ seq: log.length + 1, at: 9999, event: { type: "user", id: "u", text: String(p.text), via: "laptop key", attachments: files.map((f, i) => ({ id: `f${i}`, name: f.name, kind: "file", mediaType: "text/plain", size: 3 })) } as AgentEvent });
        log.push({ seq: log.length + 1, at: 9999, event: { type: "assistant", id: "a", text: "Done." } as AgentEvent });
        return {};
      }
      case "agent.file":
        return { attachment: { id: p.id, name: "shot.png", kind: "image", mediaType: "image/png", size: 4 }, data: "AAAA" };
    }
    throw new Error(`unknown method ${method}`);
  };
  const hub = {
    devices: async () => [{ id: "d1", rpc: true, agents: true }],
    agentRpc: async (_device: string, _agent: string, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      try {
        return { ok: true, result: answer(method, params) };
      } catch (e) {
        return { ok: false, code: "error", message: (e as Error).message };
      }
    },
  };
  const db = {
    prepare: () => ({
      bind: () => ({ all: async () => ({ results: [{ id: "d1", name: "laptop", hostname: "laptop", os: "linux", arch: "amd64" }] }) }),
    }),
  };
  const env = { PUBLIC_URL: "https://ew.test", DB: db, HUB: { idFromName: () => "id", get: () => hub } } as unknown as Env;
  const who: AgentCaller = { userId: "u1", keyId: "k1", name: "laptop key", scopes: ["read", "drive"], devices: ["d1"] };
  const ctx = (): ToolContext => ({ env, who, touched: {} });
  return { ctx, calls, log };
}

const tool = (name: string) => tools.find((t) => t.name === name)!;
const text = (out: unknown) => (typeof out === "string" ? out : JSON.stringify(out));

describe("read_thread", () => {
  const long = "x".repeat(15_000);
  const events: AgentEvent[] = [];
  for (let i = 0; i < 30; i++) {
    events.push({ type: "user", id: `u${i}`, text: `question ${i}` } as AgentEvent);
    events.push({ type: "tool", id: `t${i}`, name: "Bash", input: { command: `ls ${i}` } } as AgentEvent);
    events.push({ type: "assistant", id: `a${i}`, text: i === 10 ? long : `answer ${i}` } as AgentEvent);
  }

  test("pages back through the whole conversation, long messages in parts, nothing lost or repeated", async () => {
    const dev = fakeDevice(events);
    const seen: string[] = [];
    let before: string | undefined;
    for (let n = 0; n < 50; n++) {
      const out = text(await tool("read_thread").run(dev.ctx(), { thread: "t1", max_chars: 4000, ...(before ? { before } : {}) }));
      const body = out.split("\n\n").filter((l) => l.startsWith("#"));
      seen.unshift(...body);
      const m = /before="([\d.]+)"/.exec(out);
      if (!m) break;
      before = m[1];
    }
    const questions = seen.filter((l) => /USER: question \d+$/.test(l));
    expect(questions.length).toBe(30);
    expect(seen.some((l) => l.includes("[tool Bash]"))).toBe(false); // messages detail
    const parts = seen.filter((l) => l.includes("(part "));
    expect(parts.length).toBe(3);
    expect(parts.map((p) => p.match(/\(part (\d) of 3\)/)![1])).toEqual(["1", "2", "3"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("full detail shows tool calls; after reads forward", async () => {
    const dev = fakeDevice(events);
    const out = text(await tool("read_thread").run(dev.ctx(), { thread: "t1", detail: "full", after: "85" }));
    expect(out).toContain("[tool Bash] $ ls 29");
    expect(out).not.toContain("question 28");
    expect(out).toContain("That's the newest");
  });

  test("terminal threads and bad cursors are refused", async () => {
    const dev = fakeDevice(events);
    await expect(tool("read_thread").run(dev.ctx(), { thread: "t1", before: "abc" })).rejects.toThrow("cursor");
    await expect(tool("read_thread").run(dev.ctx(), { thread: "nope", device: "laptop" })).rejects.toThrow("no thread");
  });
});

describe("send_message", () => {
  test("sends text and files and returns the reply", async () => {
    const dev = fakeDevice([{ type: "assistant", id: "a0", text: "hi" } as AgentEvent]);
    const out = text(
      await tool("send_message").run(dev.ctx(), {
        thread: "t1",
        text: "Look at this",
        attachments: [{ name: "notes.txt", text: "abc" }],
      }),
    );
    expect(out).toContain("USER (via laptop key): Look at this");
    expect(out).toContain("notes.txt");
    expect(out).toContain("CLAUDE: Done.");
    expect(out).not.toContain("CLAUDE: hi");
    const send = dev.calls.find((c) => c.method === "agent.send")!;
    expect(send.params.files).toEqual([{ name: "notes.txt", mediaType: "text/plain", data: btoa("abc") }]);
  });

  test("refuses non-https URLs and oversized files", async () => {
    const dev = fakeDevice([]);
    await expect(tool("send_message").run(dev.ctx(), { thread: "t1", attachments: [{ name: "a", url: "http://x" }] })).rejects.toThrow("https");
    await expect(
      tool("send_message").run(dev.ctx(), { thread: "t1", attachments: [{ name: "big.txt", text: "x".repeat(9 << 20) }] }),
    ).rejects.toThrow("limit");
  });
});

describe("create_thread", () => {
  test("never offers skipping permission prompts", async () => {
    const schema = tool("create_thread").inputSchema.properties.permission_mode as { enum: string[] };
    expect(schema.enum).not.toContain("bypassPermissions");
    await expect(tool("update_thread").run(fakeDevice([]).ctx(), { thread: "t1", permission_mode: "bypassPermissions" })).rejects.toThrow(
      "permission_mode",
    );
  });
});

test("get_attachment returns images as images", async () => {
  const out = await tool("get_attachment").run(fakeDevice([]).ctx(), { thread: "t1", attachment_id: "abcdefgh" });
  expect(Array.isArray(out) && out[1]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
});

test("no tool runs commands, reads files or answers prompts", () => {
  const names = tools.map((t) => t.name);
  for (const n of ["run_command", "read_file", "write_file", "edit_file", "glob", "grep", "respond_to_request"]) {
    expect(names).not.toContain(n);
  }
});
