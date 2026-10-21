// The TypeScript SDK for everywhere plugins: a program the daemon runs,
// speaking JSON-RPC over stdin/stdout (see the daemon's
// internal/plugin/external/protocol.go). Declare what the plugin serves in
// its plugin.json, register handlers here, and call run(). Log to stderr:
// the daemon logs it.
//
//   const p = new Plugin();
//   p.method("hello.greet", async ({ params }) => `Hello, ${(params as { name: string }).name}`);
//   p.tool("wave", async ({ threadId }) => `Waved at ${threadId}`);
//   await p.run();

/** The plugin API revision this SDK speaks. */
export const API = 1;

export interface Call {
  method: string;
  params: unknown;
  /** It came from an agent connected to the account (MCP), not a browser. */
  remote: boolean;
}

export interface ToolCall {
  name: string;
  args: unknown;
  threadId: string;
}

export interface Init {
  api: number;
  id: string;
  dataDir: string;
  host: { version: string; device: unknown };
  /** Its settings' values (or defaults) at start. */
  settings: Record<string, unknown>;
}

interface Message {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** A data channel a browser opened with one of the plugin's prefixes. */
export class Stream {
  onText?: (text: string) => void;
  onBytes?: (bytes: Uint8Array) => void;
  onClose?: () => void;

  constructor(
    private readonly plugin: Plugin,
    readonly id: string,
    readonly label: string,
    /** The label after the plugin's prefix. */
    readonly rest: string,
  ) {}

  sendText(text: string): Promise<unknown> {
    return this.plugin.call("host.channel.send", { stream: this.id, text });
  }

  sendBytes(bytes: Uint8Array): Promise<unknown> {
    return this.plugin.call("host.channel.send", { stream: this.id, data: Buffer.from(bytes).toString("base64") });
  }

  close(): Promise<unknown> {
    return this.plugin.call("host.channel.close", { stream: this.id });
  }
}

export interface Io {
  /** Lines from the daemon. */
  lines: AsyncIterable<string>;
  /** Writes a line to the daemon. */
  write(line: string): void;
}

export class Plugin {
  /** Set once the daemon has said hello. */
  init?: Init;
  private methods = new Map<string, (c: Call) => unknown>();
  private tools = new Map<string, (c: ToolCall) => Promise<string> | string>();
  private streams = new Map<string, Stream>();
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  private onStream?: (s: Stream) => void;
  private onEvent?: (topic: string, payload: unknown) => void;
  private onKind?: (event: "created" | "deleted", thread: unknown) => void;
  private onConfig?: (settings: Record<string, unknown>) => void;
  /** Its settings' current values (or defaults). */
  settings: Record<string, unknown> = {};

  /**
   * Its key/value state on the device. scope is "" (its own), "thread:<id>"
   * or "project:<id>" (deleted with them). Changes reach its web part as
   * "<id>.kv.changed".
   */
  readonly kv = {
    get: async <T = unknown>(scope: string, key: string): Promise<T | undefined> => {
      const r = (await this.call("host.kv.get", { scope, key })) as { found: boolean; value?: T };
      return r.found ? r.value : undefined;
    },
    set: (scope: string, key: string, value: unknown) => this.call("host.kv.set", { scope, key, value }),
    delete: (scope: string, key: string) => this.call("host.kv.delete", { scope, key }),
    list: (scope: string, prefix = "") =>
      this.call("host.kv.list", { scope, prefix }) as Promise<{ scope: string; key: string; value: unknown }[]>,
    scopes: (prefix = "") => this.call("host.kv.scopes", { prefix }) as Promise<string[]>,
  };

  constructor(private readonly io: Io = stdio()) {}

  /** Serves a control method (declared in plugin.json's contributes.rpc). */
  method(name: string, fn: (c: Call) => unknown): this {
    this.methods.set(name, fn);
    return this;
  }

  /** Serves a tool for claude (contributes.tools), answering with text. */
  tool(name: string, fn: (c: ToolCall) => Promise<string> | string): this {
    this.tools.set(name, fn);
    return this;
  }

  /** Handles data channels browsers open (contributes.channels). */
  streamsOpened(fn: (s: Stream) => void): this {
    this.onStream = fn;
    return this;
  }

  /** Handles the bus events it listens to (contributes.events). */
  events(fn: (topic: string, payload: unknown) => void): this {
    this.onEvent = fn;
    return this;
  }

  /** Handles its tab kinds being created and deleted. */
  kinds(fn: (event: "created" | "deleted", thread: unknown) => void): this {
    this.onKind = fn;
    return this;
  }

  /** Called with its settings when the user changes them. */
  settingsChanged(fn: (settings: Record<string, unknown>) => void): this {
    this.onConfig = fn;
    return this;
  }

  /** A thread (or tab), with its live fields. */
  thread(id: string): Promise<{ id: string; name: string; kind: string; projectId: string } & Record<string, unknown>> {
    return this.call("host.threads.get", { id }) as never;
  }

  /** Sends an event to every browser; its "event" starts with the plugin's id and a dot. */
  emit(event: { event: string } & Record<string, unknown>): Promise<unknown> {
    return this.call("host.emit", { event });
  }

  async workdir(threadId: string): Promise<string> {
    const w = (await this.call("host.threads.workdir", { id: threadId })) as { path: string };
    return w.path;
  }

  /** Tells a thread's claude something (needs agent.notify). */
  notifyAgent(threadId: string, name: string, text: string, wake = false): Promise<unknown> {
    return this.call("host.agent.notify", { threadId, name, text, wake });
  }

  log(level: "debug" | "info" | "warn" | "error", message: string): Promise<unknown> {
    return this.call("host.log", { level, message });
  }

  /** Asks the daemon something. */
  call(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Serves until the daemon closes stdin or says shutdown. */
  async run(): Promise<void> {
    for await (const line of this.io.lines) {
      if (!line.trim()) continue;
      let m: Message;
      try {
        m = JSON.parse(line) as Message;
      } catch {
        continue;
      }
      if (m.method === "shutdown") return;
      this.dispatch(m);
    }
  }

  private send(m: Message) {
    this.io.write(JSON.stringify(m));
  }

  private dispatch(m: Message) {
    if (!m.method) {
      const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
      if (!p) return;
      this.pending.delete(m.id!);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
      return;
    }
    void (async () => {
      try {
        const result = await this.handle(m.method!, m.params as Record<string, unknown>);
        if (m.id !== undefined) this.send({ jsonrpc: "2.0", id: m.id, result: result ?? {} });
      } catch (e) {
        if (m.id !== undefined) {
          this.send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } });
        }
      }
    })();
  }

  private async handle(method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize":
        this.init = p as unknown as Init;
        this.settings = this.init.settings ?? {};
        return { api: API };
      case "config":
        this.settings = (p.settings as Record<string, unknown>) ?? {};
        this.onConfig?.(this.settings);
        return;
      case "rpc": {
        const fn = this.methods.get(String(p.method));
        if (!fn) throw new Error(`unknown method ${String(p.method)}`);
        return fn({ method: String(p.method), params: p.params, remote: !!p.remote });
      }
      case "tool": {
        const fn = this.tools.get(String(p.name));
        if (!fn) throw new Error(`unknown tool ${String(p.name)}`);
        try {
          return { text: await fn({ name: String(p.name), args: p.args, threadId: String(p.threadId ?? "") }) };
        } catch (e) {
          return { text: e instanceof Error ? e.message : String(e), isError: true };
        }
      }
      case "channel.open": {
        const s = new Stream(this, String(p.stream), String(p.label), String(p.rest));
        this.streams.set(s.id, s);
        this.onStream?.(s);
        return;
      }
      case "channel.message": {
        const s = this.streams.get(String(p.stream));
        if (typeof p.text === "string") s?.onText?.(p.text);
        else if (typeof p.data === "string") s?.onBytes?.(new Uint8Array(Buffer.from(p.data, "base64")));
        return;
      }
      case "channel.close": {
        const s = this.streams.get(String(p.stream));
        this.streams.delete(String(p.stream));
        s?.onClose?.();
        return;
      }
      case "event":
        this.onEvent?.(String(p.topic), p.payload);
        return;
      case "kind.created":
      case "kind.deleted":
        this.onKind?.(method === "kind.created" ? "created" : "deleted", p.thread);
        return;
    }
    throw new Error(`unknown method ${method}`);
  }
}

/** The daemon's end: stdin and stdout. */
export function stdio(): Io {
  return {
    lines: (async function* () {
      let buf = "";
      const decoder = new TextDecoder();
      for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          yield buf.slice(0, i);
          buf = buf.slice(i + 1);
        }
      }
      if (buf) yield buf;
    })(),
    write: (line) => void process.stdout.write(`${line}\n`),
  };
}
