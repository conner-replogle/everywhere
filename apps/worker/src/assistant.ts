import { DurableObject } from "cloudflare:workers";
import type {
  AssistantClientMsg,
  AssistantEntry,
  AssistantEntryData,
  AssistantLive,
  AssistantServerMsg,
} from "@everywhere/protocol";
import { HUB_PING, HUB_PONG } from "@everywhere/protocol";
import { randomId } from "./crypto";
import { open, seal } from "./secretbox";

export const ASSISTANT_SESSION_HEADER = "x-ew-session";

/** The account's OpenAI API key (for GPT-Live, the voice), as the app may see it. */
export type OpenAIKeyInfo = { set: false } | { set: true; hint: string; setAt: number };
interface StoredKey {
  sealed: string;
  /** Its last four characters, to tell keys apart in Settings. */
  hint: string;
  setAt: number;
}

interface Attachment {
  id: string;
  session: string;
}

/** A frame of entries stays well under the 1 MiB WebSocket message limit. */
const FRAME_BYTES = 512 * 1024;
/** One entry: a long tool result is cut by the agent before it gets here. */
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_APPEND = 50;
const HISTORY_PAGE = 100;
/** On a fresh attach without a compaction yet, the newest this many. */
const FIRST_ATTACH = 400;

/**
 * One per account: the assistant's conversation. Its agent runs in the
 * account's browser tabs; this keeps the log (SQLite), lets one tab at a time
 * run turns (the runner), and relays what that turn is doing to the others.
 * It never reaches a device: the tab running the turn does that over its own
 * WebRTC connections.
 */
export class Assistant extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      data TEXT NOT NULL
    )`);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HUB_PING, HUB_PONG));
  }

  override async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const id = randomId();
    this.ctx.acceptWebSocket(server, [`conn:${id}`]);
    server.serializeAttachment({ id, session: request.headers.get(ASSISTANT_SESSION_HEADER) ?? "" } satisfies Attachment);
    send(server, { t: "hello", you: id, runner: this.runner(), live: this.live(), clearedThrough: this.clearedThrough() });
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const me = ws.deserializeAttachment() as Attachment;
    let m: AssistantClientMsg;
    try {
      m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as AssistantClientMsg;
    } catch {
      return send(ws, { t: "error", message: "invalid JSON" });
    }
    switch (m?.t) {
      case "attach":
        return this.attach(ws, typeof m.afterSeq === "number" ? m.afterSeq : undefined);
      case "history": {
        const limit = Math.min(Math.max(1, m.limit ?? HISTORY_PAGE), 500);
        const rows = this.rows("SELECT * FROM entries WHERE seq < ? ORDER BY seq DESC LIMIT ?", m.beforeSeq, limit + 1);
        const more = rows.length > limit;
        return send(ws, { t: "history", entries: rows.slice(0, limit).reverse(), more });
      }
      case "append":
        return this.append(ws, m.ref, m.entries);
      case "claim": {
        const runner = this.runner();
        if (runner && runner !== me.id) return send(ws, { t: "runner", runner });
        this.setRunner(me.id);
        return;
      }
      case "release":
        if (this.runner() === me.id) this.setRunner(null);
        return;
      case "live":
        if (this.runner() !== me.id) return;
        this.ctx.storage.kv.put("live", m.live);
        this.broadcast({ t: "live", live: m.live }, ws);
        return;
      case "steer":
      case "approve": {
        const runner = this.runner();
        const target = runner ? this.socket(runner) : undefined;
        if (!target || runner === me.id) return send(ws, { t: "noRunner", text: m.t === "steer" ? m.text : undefined });
        return send(target, m.t === "steer" ? { t: "steer", text: m.text, from: m.from } : { t: "approve", id: m.id, allow: m.allow });
      }
      case "clear":
        return this.clear(ws);
      case "voice":
        return this.broadcast({ t: "voice", tab: String(m.tab) }, ws);
      default:
        return send(ws, { t: "error", message: "unknown message" });
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.gone(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.gone(ws);
  }

  openAIKeyInfo(): OpenAIKeyInfo {
    const k = this.ctx.storage.kv.get<StoredKey>("openaiKey");
    return k ? { set: true, hint: k.hint, setAt: k.setAt } : { set: false };
  }

  /** Keeps the key sealed, or with "" forgets it. */
  async setOpenAIKey(key: string): Promise<OpenAIKeyInfo> {
    if (key) this.ctx.storage.kv.put<StoredKey>("openaiKey", { sealed: await seal(this.env, key), hint: key.slice(-4), setAt: Date.now() });
    else this.ctx.storage.kv.delete("openaiKey");
    return this.openAIKeyInfo();
  }

  /** The key itself, for the Worker's own calls to OpenAI; never sent to a browser. */
  async openAIKey(): Promise<string | null> {
    const k = this.ctx.storage.kv.get<StoredKey>("openaiKey");
    return k ? open(this.env, k.sealed) : null;
  }

  /** Closes the sockets of signed-out sessions. */
  async revokeSessions(sessionIds: string[]): Promise<void> {
    const ids = new Set(sessionIds);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment;
      if (ids.has(a.session)) ws.close(4003, "session revoked");
    }
  }

  private attach(ws: WebSocket, afterSeq: number | undefined): void {
    let rows: AssistantEntry[];
    if (afterSeq !== undefined) {
      rows = this.rows("SELECT * FROM entries WHERE seq > ? ORDER BY seq", afterSeq);
    } else {
      // The latest compaction and what it doesn't cover: what the agent needs.
      const [c] = this.rows("SELECT * FROM entries WHERE kind = 'compaction' ORDER BY seq DESC LIMIT 1");
      rows =
        c?.kind === "compaction"
          ? [c, ...this.rows("SELECT * FROM entries WHERE seq > ? AND seq != ? ORDER BY seq", c.throughSeq, c.seq)]
          : this.rows("SELECT * FROM entries ORDER BY seq DESC LIMIT ?", FIRST_ATTACH).reverse();
    }
    let frame: AssistantEntry[] = [];
    let bytes = 0;
    for (const e of rows) {
      const n = JSON.stringify(e).length;
      if (frame.length && bytes + n > FRAME_BYTES) {
        send(ws, { t: "entries", entries: frame, initial: true });
        frame = [];
        bytes = 0;
      }
      frame.push(e);
      bytes += n;
    }
    if (frame.length) send(ws, { t: "entries", entries: frame, initial: true });
    send(ws, { t: "synced" });
  }

  private append(ws: WebSocket, ref: string, entries: AssistantEntryData[]): void {
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_APPEND) {
      return send(ws, { t: "error", message: "bad append" });
    }
    const added: AssistantEntry[] = [];
    for (const e of entries) {
      const data = entryData(e);
      if (!data) return send(ws, { t: "error", message: "bad entry" });
      const json = JSON.stringify(data);
      if (json.length > MAX_ENTRY_BYTES) return send(ws, { t: "error", message: "entry too big" });
      const at = Date.now();
      const row = this.sql
        .exec<{ seq: number }>("INSERT INTO entries (at, kind, data) VALUES (?, ?, ?) RETURNING seq", at, data.kind, json)
        .one();
      added.push({ ...data, seq: row.seq, at });
    }
    send(ws, { t: "appended", ref: String(ref).slice(0, 64), seqs: added.map((e) => e.seq) });
    this.broadcast({ t: "entries", entries: added });
  }

  /**
   * Deletes the whole conversation. Not while a turn runs: its tab would go
   * on adding the old conversation to the new one. Seqs keep counting (the
   * AUTOINCREMENT table remembers), so a tab that missed this can tell its
   * entries are gone from clearedThrough.
   */
  private clear(ws: WebSocket): void {
    if (this.runner()) return send(ws, { t: "error", re: "clear", message: "The assistant is in the middle of a turn. Stop it, then clear." });
    const last = this.sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM entries").one().seq ?? this.clearedThrough();
    this.sql.exec("DELETE FROM entries");
    this.ctx.storage.kv.put("clearedThrough", last);
    this.ctx.storage.kv.put("live", null);
    this.broadcast({ t: "cleared", throughSeq: last });
  }

  private clearedThrough(): number {
    return this.ctx.storage.kv.get<number>("clearedThrough") ?? 0;
  }

  private rows(query: string, ...bindings: unknown[]): AssistantEntry[] {
    return this.sql
      .exec<{ seq: number; at: number; data: string }>(query, ...bindings)
      .toArray()
      .map((r) => ({ ...(JSON.parse(r.data) as AssistantEntryData), seq: r.seq, at: r.at }));
  }

  private gone(ws: WebSocket): void {
    const me = ws.deserializeAttachment() as Attachment | null;
    if (me && this.runner() === me.id) this.setRunner(null);
  }

  /** The runner, if its socket is still open. */
  private runner(): string | null {
    const id = this.ctx.storage.kv.get<string>("runner") ?? null;
    return id && this.socket(id) ? id : null;
  }

  private setRunner(id: string | null): void {
    this.ctx.storage.kv.put("runner", id);
    if (!id) this.ctx.storage.kv.put("live", null);
    this.broadcast({ t: "runner", runner: id });
    if (!id) this.broadcast({ t: "live", live: null });
  }

  private live(): AssistantLive | null {
    return this.runner() ? (this.ctx.storage.kv.get<AssistantLive | null>("live") ?? null) : null;
  }

  private socket(id: string): WebSocket | undefined {
    return this.ctx.getWebSockets(`conn:${id}`).find((ws) => ws.readyState === WebSocket.OPEN);
  }

  private broadcast(msg: AssistantServerMsg, except?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) send(ws, msg);
  }
}

/** The entry with only the fields its kind has, or null if it's malformed. */
function entryData(e: unknown): AssistantEntryData | null {
  const x = e as Record<string, unknown> | null;
  if (x?.kind === "message" && typeof x.message === "object" && x.message !== null) {
    return { kind: "message", message: x.message };
  }
  if (x?.kind === "compaction" && typeof x.summary === "string" && typeof x.throughSeq === "number") {
    return { kind: "compaction", summary: x.summary, throughSeq: x.throughSeq };
  }
  return null;
}

function send(ws: WebSocket, msg: AssistantServerMsg): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Closed between lookup and send; its close handler cleans up.
  }
}
