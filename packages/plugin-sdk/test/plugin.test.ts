import { expect, test } from "bun:test";
import { type Io, Plugin } from "../src";

/** A fake daemon: lines it sends, and what the plugin wrote. */
function fakeDaemon() {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const written: Record<string, unknown>[] = [];
  const io: Io = {
    lines: (async function* () {
      while (true) {
        if (queue.length) yield queue.shift()!;
        else if (closed) return;
        else await new Promise<void>((r) => (wake = r));
      }
    })(),
    write: (line) => written.push(JSON.parse(line)),
  };
  const send = (m: unknown) => {
    queue.push(JSON.stringify(m));
    wake?.();
  };
  const close = () => {
    closed = true;
    wake?.();
  };
  const reply = async (id: number) => {
    for (let i = 0; i < 100; i++) {
      const r = written.find((w) => w.id === id && !("method" in w));
      if (r) return r;
      await Bun.sleep(5);
    }
    throw new Error(`no reply to ${id}`);
  };
  return { io, send, close, reply, written };
}

test("serves methods and tools, and asks the daemon", async () => {
  const d = fakeDaemon();
  const p = new Plugin(d.io)
    .method("hello.greet", ({ params, remote }) => ({ greeting: `Hello, ${(params as { name: string }).name}`, remote }))
    .tool("wave", async ({ threadId }) => {
      await p.emit({ event: "hello.waved", threadId });
      return `waved at ${threadId}`;
    });
  const running = p.run();

  let heard: Record<string, unknown> | undefined;
  p.settingsChanged((s) => (heard = s));
  d.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { api: 1, id: "hello", dataDir: "/tmp/x", host: {}, settings: { greeting: "Hello" } } });
  expect((await d.reply(1)).result).toEqual({ api: 1 });
  expect(p.init?.dataDir).toBe("/tmp/x");
  expect(p.settings.greeting).toBe("Hello");
  d.send({ jsonrpc: "2.0", method: "config", params: { settings: { greeting: "Hi" } } });
  for (let i = 0; i < 100 && !heard; i++) await Bun.sleep(5);
  expect(heard?.greeting).toBe("Hi");

  d.send({ jsonrpc: "2.0", id: 2, method: "rpc", params: { method: "hello.greet", params: { name: "Ada" }, remote: true } });
  expect((await d.reply(2)).result).toEqual({ greeting: "Hello, Ada", remote: true });

  d.send({ jsonrpc: "2.0", id: 3, method: "rpc", params: { method: "hello.nope" } });
  expect((await d.reply(3)).error).toBeDefined();

  // The tool emits through the daemon, which answers, before the tool does.
  d.send({ jsonrpc: "2.0", id: 4, method: "tool", params: { name: "wave", args: {}, threadId: "t1" } });
  let ask: Record<string, unknown> | undefined;
  for (let i = 0; i < 100 && !ask; i++) {
    ask = d.written.find((w) => w.method === "host.emit");
    if (!ask) await Bun.sleep(5);
  }
  expect(ask?.params).toEqual({ event: { event: "hello.waved", threadId: "t1" } });
  d.send({ jsonrpc: "2.0", id: ask!.id, result: {} });
  expect((await d.reply(4)).result).toEqual({ text: "waved at t1" });

  d.send({ jsonrpc: "2.0", method: "shutdown" });
  await running;
});
