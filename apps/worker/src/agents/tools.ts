// Connected agents' MCP tools. Each resolves a device the key may reach, then
// relays requests to its daemon through the AccountHub (see AgentMethods in
// the protocol). The daemon answers only while the device allows connected
// agents, and only those methods: these tools read threads and drive agent
// threads, never run commands, read other files or answer permission prompts.
import type {
  AgentAttachment,
  AgentEvent,
  AgentFile,
  AgentMethod,
  AgentMethods,
  AgentRead,
  AgentState,
  PermissionMode,
  Project,
  Thread,
} from "@everywhere/protocol";
import type { DeviceRpcResult } from "../hub";
import type { AgentCaller, Scope } from "./keys";

export class ToolError extends Error {}

export interface ToolContext {
  env: Env;
  who: AgentCaller;
  /** What the call touched, for the activity list. */
  touched: { deviceId?: string; threadId?: string };
}

type Args = Record<string, unknown>;

/** An MCP content block. */
export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

export interface Tool {
  name: string;
  title: string;
  scope: Scope;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
  run(ctx: ToolContext, args: Args): Promise<string | Content[]>;
}

const WAIT_DEFAULT_S = 30;
const WAIT_MAX_S = 50;
/** read_thread's page, in characters. */
const PAGE_DEFAULT = 20_000;
const PAGE_MAX = 60_000;
/** Long messages are read in parts this long, so cursors into them stay put whatever the page size. */
const PART_CHARS = 6_000;
/** Events per agent.read, and how many reads one page may take. */
const READ_BATCH = 400;
const READ_ROUNDS = 6;
/** Files sent with a prompt: each, and all together. */
const FILE_MAX = 8 << 20;
const FILES_MAX = 16 << 20;

// --- devices and rpc ------------------------------------------------------------

interface Device {
  id: string;
  name: string;
  hostname: string;
  os: string;
  arch: string;
  online: boolean;
  /** Its daemon is new enough to serve connected agents. */
  capable: boolean;
}

function hub(ctx: ToolContext) {
  return ctx.env.HUB.get(ctx.env.HUB.idFromName(ctx.who.userId));
}

/** The devices this key may reach. */
async function listDevices(ctx: ToolContext): Promise<Device[]> {
  if (ctx.who.devices.length === 0) return [];
  const marks = ctx.who.devices.map(() => "?").join(", ");
  const [{ results }, online] = await Promise.all([
    ctx.env.DB.prepare(
      `SELECT id, name, hostname, os, arch FROM devices
       WHERE account_id = ? AND revoked_at IS NULL AND id IN (${marks}) ORDER BY name`,
    )
      .bind(ctx.who.userId, ...ctx.who.devices)
      .all<Omit<Device, "online" | "capable">>(),
    hub(ctx).devices(),
  ]);
  const status = new Map(online.map((d) => [d.id, d.agents]));
  return results.map((d) => ({ ...d, online: status.has(d.id), capable: status.get(d.id) === true }));
}

function deviceNames(devices: Device[]): string {
  return devices.map((x) => `${x.name} (${x.id})`).join(", ") || "none";
}

/** A device by id, or by name or hostname (case-insensitive). */
async function resolveDevice(ctx: ToolContext, ref: unknown): Promise<Device> {
  if (typeof ref !== "string" || !ref.trim()) throw new ToolError("device is required");
  const devices = await listDevices(ctx);
  const want = ref.trim().toLowerCase();
  const d =
    devices.find((x) => x.id === ref.trim()) ??
    devices.find((x) => x.name.toLowerCase() === want) ??
    devices.find((x) => x.hostname.toLowerCase() === want);
  if (!d) throw new ToolError(`no device "${ref}" this key can reach; it can reach: ${deviceNames(devices)}`);
  usable(d);
  ctx.touched.deviceId = d.id;
  return d;
}

function usable(d: Device) {
  if (!d.online) throw new ToolError(`${d.name} is offline`);
  if (!d.capable) throw new ToolError(`${d.name}'s everywhere is too old for connected agents; update it (everywhere update on the device)`);
}

/** Devices to fan out to: one if named, else every one that's online and new enough. */
async function targetDevices(ctx: ToolContext, ref: unknown): Promise<{ devices: Device[]; skipped: Device[] }> {
  if (typeof ref === "string" && ref.trim()) return { devices: [await resolveDevice(ctx, ref)], skipped: [] };
  const all = await listDevices(ctx);
  return { devices: all.filter((d) => d.online && d.capable), skipped: all.filter((d) => !d.online || !d.capable) };
}

async function call<M extends AgentMethod>(
  ctx: ToolContext,
  device: Device,
  method: M,
  params: AgentMethods[M][0],
  timeoutMs?: number,
): Promise<AgentMethods[M][1]> {
  // Typed by hand: narrowing doesn't survive the stub's RPC types.
  const r = (await hub(ctx).agentRpc(device.id, ctx.who.name, method, params, timeoutMs)) as DeviceRpcResult<AgentMethods[M][1]>;
  if (r.ok) return r.result;
  if (r.code === "unsupported" || r.message.startsWith("unknown method")) {
    throw new ToolError(`${device.name}'s everywhere is too old for this; update it (everywhere update on the device)`);
  }
  throw new ToolError(`${device.name}: ${r.message}`);
}

function unavailable(d: Device): string {
  return `${d.name} (${d.id}): ${!d.online ? "offline" : "its everywhere is too old for connected agents"}`;
}

// --- arguments -------------------------------------------------------------------

function str(args: Args, key: string, required: true): string;
function str(args: Args, key: string, required?: false): string | undefined;
function str(args: Args, key: string, required = false): string | undefined {
  const v = args[key];
  if (typeof v === "string" && v.trim() !== "") return v;
  if (v !== undefined && v !== null && typeof v !== "string") throw new ToolError(`${key} must be a string`);
  if (required) throw new ToolError(`${key} is required`);
  return undefined;
}

function num(args: Args, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ToolError(`${key} must be a number`);
  return n;
}

function bool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ToolError(`${key} must be true or false`);
  return v;
}

function oneOf<T extends string>(args: Args, key: string, values: readonly T[]): T | undefined {
  const v = str(args, key);
  if (v === undefined) return undefined;
  if (!values.includes(v as T)) throw new ToolError(`${key} must be one of ${values.join(", ")}`);
  return v as T;
}

function waitMs(args: Args, fallbackS: number): number {
  const s = num(args, "wait_seconds") ?? fallbackS;
  return Math.max(0, Math.min(s, WAIT_MAX_S)) * 1000;
}

// --- threads ---------------------------------------------------------------------

function threadUrl(env: Env, deviceId: string, threadId: string): string {
  return `${env.PUBLIC_URL}/d/${deviceId}/t/${threadId}`;
}

function ago(ms: number | null | undefined): string {
  if (!ms) return "never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 90 * 60) return `${Math.round(s / 60)}m ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function threadStatus(t: Thread): string {
  if (t.archivedAt) return "archived";
  if (t.kind === "terminal") return t.running ? "running" : "closed";
  if (t.doneAt && t.agentStatus !== "working" && t.agentStatus !== "waiting") return "done";
  return t.agentStatus ?? "stopped";
}

function threadLine(d: Device, t: Thread, project?: Project): string {
  const where = project ? (project.isScratch ? "Scratch" : project.name) : "?";
  return (
    `- "${t.name}" thread_id=${t.id} · ${t.kind} · ${threadStatus(t)} · ${where} on ${d.name} (device ${d.id})` +
    ` · last active ${ago(t.lastOpenedAt ?? t.createdAt)}${t.worktree ? " · worktree" : ""}`
  );
}

/** A thread by id or exact name: on one device, or the first of the key's devices that has it. */
async function resolveThread(ctx: ToolContext, deviceRef: unknown, threadRef: unknown): Promise<{ d: Device; thread: Thread }> {
  if (typeof threadRef !== "string" || !threadRef.trim()) throw new ToolError("thread is required");
  const ref = threadRef.trim();
  const { devices, skipped } = await targetDevices(ctx, deviceRef);
  const found = await Promise.all(
    devices.map(async (d) => {
      const byId = await call(ctx, d, "threads.get", { threadId: ref }).catch(() => null);
      if (byId) return { d, thread: byId };
      const list = await call(ctx, d, "threads.list", {}).catch(() => [] as Thread[]);
      const byName = list.filter((t) => t.name.toLowerCase() === ref.toLowerCase());
      return byName.length === 1 ? { d, thread: byName[0]! } : null;
    }),
  );
  const hits = found.filter((x) => x !== null);
  if (hits.length > 1) throw new ToolError(`"${ref}" is on more than one device; pass device`);
  const hit = hits[0];
  if (!hit) {
    const off = skipped.length ? ` (not checked: ${skipped.map(unavailable).join("; ")})` : "";
    throw new ToolError(`no thread "${ref}" on the devices this key can reach${off}; find it with list_threads or search_threads`);
  }
  ctx.touched.deviceId = hit.d.id;
  ctx.touched.threadId = hit.thread.id;
  return hit;
}

// --- transcripts -------------------------------------------------------------------

type Detail = "messages" | "full";

/** A position in a thread's log: an event, and a part of it for long messages. */
interface Cursor {
  seq: number;
  part: number;
}

function cursorText(c: Cursor): string {
  return c.part > 1 ? `${c.seq}.${c.part}` : `${c.seq}`;
}

function parseCursor(args: Args, key: string): Cursor | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(v).trim());
  if (!m) throw new ToolError(`${key} must be a cursor from read_thread, like "1234" or "1234.2"`);
  return { seq: Number(m[1]), part: m[2] ? Number(m[2]) : 1 };
}

/** One piece of a page: a whole event, or a part of a long one. */
interface Unit {
  seq: number;
  part: number;
  text: string;
}

function clip(s: string, max: number): string {
  s = s.trim();
  return s.length > max ? `${s.slice(0, max)}… [${s.length - max} more chars]` : s;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1 << 20)).toFixed(1)} MB`;
}

function filesLine(atts: AgentAttachment[] | undefined): string {
  if (!atts?.length) return "";
  return `\n[files: ${atts.map((a) => `${a.name} (${a.mediaType}, ${size(a.size)}, attachment_id ${a.id})`).join("; ")}]`;
}

function toolLine(name: string, input: unknown): string {
  const i = obj(input);
  const s = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  switch (name) {
    case "Bash":
      return `$ ${clip(s("command"), 500)}`;
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return s("file_path");
    case "Grep":
    case "Glob":
      return [s("pattern"), s("path") || s("glob")].filter(Boolean).join(" in ");
    case "WebFetch":
      return s("url");
    case "WebSearch":
      return s("query");
    case "Agent":
    case "Task":
      return s("description");
    case "TodoWrite":
      return Array.isArray(i.todos)
        ? i.todos.map((t) => `${obj(t).status === "completed" ? "[x]" : "[ ]"} ${String(obj(t).content ?? "")}`).join("; ")
        : "";
    case "ExitPlanMode":
      return clip(s("plan"), 4000);
  }
  return clip(JSON.stringify(input) ?? "", 300);
}

/** An event as text, or null when the detail level leaves it out. */
function eventText(ev: AgentEvent, detail: Detail): string | null {
  // A subagent's own steps; its result shows on the parent's tool call.
  if (ev.parentId) return null;
  switch (ev.type) {
    case "user":
      return `USER${ev.via ? ` (via ${ev.via})` : ""}: ${ev.text ?? ""}${filesLine(ev.attachments)}`;
    case "assistant":
      return `CLAUDE: ${ev.text}`;
    case "files":
      return `CLAUDE shared files${ev.text ? `: ${ev.text}` : ""}${filesLine(ev.attachments)}`;
    case "turn":
      if (ev.status === "started" || (ev.status === "completed" && detail === "messages")) return null;
      return `— turn ${ev.status}${ev.durationMs ? ` (${Math.round(ev.durationMs / 1000)}s)` : ""}${ev.text && ev.status !== "completed" ? `: ${ev.text}` : ""} —`;
    case "notice":
      return `[notice] ${ev.text}`;
    case "rewind":
      return `[the conversation was rolled back to before: "${clip(ev.text, 200)}"]`;
    case "request":
      return `[${ev.kind === "tool" ? `permission for ${ev.toolName}` : ev.kind}: ${ev.decision}${ev.text ? ` (${clip(ev.text, 300)})` : ""}]`;
    case "commandOutput":
      return detail === "full" ? `[command output] ${clip(ev.text, 2000)}` : null;
    case "tool":
      return detail === "full" ? `[tool ${ev.name}] ${toolLine(ev.name, ev.input)}` : null;
    case "toolResult":
      if (detail !== "full") return null;
      return ev.isError ? `[  ↳ error] ${clip(ev.output, 1000)}` : `[  ↳] ${clip(ev.output, 400)}${filesLine(ev.attachments)}`;
    case "process":
      return detail === "full" ? `[process ${ev.name}] ${clip(ev.text, 600)}` : null;
  }
  return null;
}

/** Events as units, oldest first; long ones split into parts. */
function units(events: AgentRead["events"], detail: Detail): Unit[] {
  const out: Unit[] = [];
  for (const e of events) {
    const text = eventText(e.event, detail);
    if (text === null) continue;
    const label = `#${e.seq}`;
    if (text.length <= PART_CHARS) {
      out.push({ seq: e.seq, part: 1, text: `${label} ${text}` });
      continue;
    }
    const parts = Math.ceil(text.length / PART_CHARS);
    for (let i = 0; i < parts; i++) {
      out.push({ seq: e.seq, part: i + 1, text: `${label} (part ${i + 1} of ${parts}) ${text.slice(i * PART_CHARS, (i + 1) * PART_CHARS)}` });
    }
  }
  return out;
}

const before = (u: Unit, c: Cursor) => u.seq < c.seq || (u.seq === c.seq && u.part < c.part);
const after = (u: Unit, c: Cursor) => u.seq > c.seq || (u.seq === c.seq && u.part > c.part);

interface Page {
  read: AgentRead;
  units: Unit[];
  /** Read older units from here (exclusive); absent at the start of the thread. */
  older?: Cursor;
  /** Read newer units from here (exclusive); absent when this page reaches the newest. */
  newer?: Cursor;
}

/** The newest page before cursor (or of the whole thread), newest units kept whole within budget. */
async function pageBack(ctx: ToolContext, d: Device, threadId: string, cur: Cursor | undefined, budget: number, detail: Detail, wait: number): Promise<Page> {
  let beforeSeq = cur ? (cur.part > 1 ? cur.seq + 1 : cur.seq) : undefined;
  let read: AgentRead | undefined;
  let pool: Unit[] = [];
  let more = true;
  for (let round = 0; round < READ_ROUNDS && more; round++) {
    const r = await call(
      ctx,
      d,
      "agent.read",
      { threadId, beforeSeq, limit: READ_BATCH, waitMs: round === 0 ? wait : 0 },
      (round === 0 ? wait : 0) + 25_000,
    );
    read ??= r;
    pool = [...units(r.events, detail).filter((u) => !cur || before(u, cur)), ...pool];
    more = r.more;
    beforeSeq = r.events[0]?.seq;
    if (!beforeSeq) more = false;
    if (pool.reduce((n, u) => n + u.text.length + 2, 0) >= budget) break;
  }
  const page: Unit[] = [];
  let used = 0;
  for (let i = pool.length - 1; i >= 0; i--) {
    const u = pool[i]!;
    if (page.length && used + u.text.length + 2 > budget) break;
    page.unshift(u);
    used += u.text.length + 2;
  }
  const first = page[0];
  const olderLeft = first ? pool.indexOf(first) > 0 || more : more;
  return { read: read!, units: page, ...(olderLeft && first ? { older: { seq: first.seq, part: first.part } } : {}) };
}

/** The oldest page after cursor, up to budget. */
async function pageForward(ctx: ToolContext, d: Device, threadId: string, cur: Cursor, budget: number, detail: Detail, wait: number): Promise<Page> {
  const afterSeq = cur.part > 1 ? cur.seq - 1 : cur.seq;
  // agent.read gives the newest events after afterSeq; page back to the oldest.
  let read = await call(ctx, d, "agent.read", { threadId, afterSeq, limit: READ_BATCH, waitMs: wait }, wait + 25_000);
  const newest = read;
  let events = read.events;
  for (let round = 1; round < READ_ROUNDS && read.more && events[0]; round++) {
    read = await call(ctx, d, "agent.read", { threadId, afterSeq, beforeSeq: events[0].seq, limit: READ_BATCH });
    events = [...read.events, ...events];
  }
  const pool = units(events, detail).filter((u) => after(u, cur));
  const page: Unit[] = [];
  let used = 0;
  for (const u of pool) {
    if (page.length && used + u.text.length + 2 > budget) break;
    page.push(u);
    used += u.text.length + 2;
  }
  const last = page[page.length - 1];
  const newerLeft = last && pool.indexOf(last) < pool.length - 1;
  return {
    read: newest,
    units: page,
    ...(newerLeft ? { newer: { seq: last.seq, part: last.part } } : {}),
    ...(read.more || cur.seq > 0 ? { older: page[0] ? { seq: page[0].seq, part: page[0].part } : cur } : {}),
  };
}

function inputSummary(input: unknown): string {
  const o = obj(input);
  for (const k of ["command", "file_path", "path", "url", "pattern", "description", "plan"]) {
    if (typeof o[k] === "string") return clip(o[k] as string, k === "plan" ? 2000 : 300);
  }
  return clip(JSON.stringify(input) ?? "", 300);
}

function stateLines(state: AgentState): string[] {
  const model = state.activeModel || state.model || "default";
  const ws =
    state.workspace.mode === "worktree"
      ? `worktree${state.workspace.branch ? ` on branch ${state.workspace.branch}` : ""}`
      : "project checkout";
  const lines = [
    `Status: ${state.status}${state.error ? ` (${state.error})` : ""} · model ${model} · permission mode ${state.permissionMode} · ${ws}` +
      (state.context ? ` · context ${Math.round(state.context.percentage)}% full` : ""),
  ];
  for (const r of state.pending) {
    const what = r.kind === "tool" ? `permission to use ${r.toolName}: ${inputSummary(r.input)}` : r.kind === "plan" ? `approval of a plan: ${inputSummary(r.input)}` : `an answer to a question: ${clip(JSON.stringify(obj(r.input).questions ?? r.input), 1500)}`;
    lines.push(`Waiting for the user to give ${what}. Only the user can answer this, in everywhere; you can't. Tell them, or wait (read_thread with wait_seconds).`);
  }
  const streaming = state.streaming.filter((s) => s.kind === "text" && s.text.trim());
  if (streaming.length) lines.push(`Claude is writing: ${clip(streaming.map((s) => s.text).join("\n"), 3000)}`);
  return lines;
}

function formatPage(env: Env, d: Device, p: Page, heading: boolean): string {
  const { thread, state } = p.read;
  const lines: string[] = [];
  if (heading) {
    lines.push(`Thread "${thread.name}" (thread_id ${thread.id}) on ${d.name} (device ${d.id})${thread.archivedAt ? ", archived" : ""}`);
    lines.push(`Link for the user: ${threadUrl(env, d.id, thread.id)}`);
  }
  lines.push(...stateLines(state));
  lines.push("");
  if (p.units.length === 0) lines.push("(nothing here yet)");
  else lines.push(p.units.map((u) => u.text).join("\n\n"));
  lines.push("");
  if (p.older) lines.push(`Older: read_thread with before="${cursorText(p.older)}".`);
  if (p.newer) lines.push(`Newer: read_thread with after="${cursorText(p.newer)}".`);
  else {
    const working = state.status === "working" || state.status === "starting";
    lines.push(
      working
        ? `Claude is still working. To wait for it: read_thread with after="${p.read.lastSeq}" and wait_seconds=${WAIT_MAX_S}.`
        : `That's the newest. Later, read what's new with after="${p.read.lastSeq}".`,
    );
  }
  if (state.suggestion && state.status === "idle") lines.push(`Claude's suggested next prompt: ${state.suggestion}`);
  return lines.join("\n");
}

// --- files ------------------------------------------------------------------------------

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
};

function mediaTypeOf(name: string): string {
  return MEDIA_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

function isText(mediaType: string): boolean {
  return /^text\/|[/+](json|xml|yaml|javascript|typescript|x-sh|toml|csv)$/.test(mediaType);
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(data: string): Uint8Array {
  const raw = atob(data.replace(/\s+/g, ""));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The attachments argument as files for agent.send: inline text, base64, or an https URL to fetch. */
async function filesArg(args: Args): Promise<AgentFile[]> {
  const v = args.attachments;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ToolError("attachments must be an array");
  if (v.length > 10) throw new ToolError("at most 10 attachments at a time");
  const out: AgentFile[] = [];
  let total = 0;
  for (const raw of v) {
    const a = obj(raw);
    const name = typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, 200) : "";
    if (!name) throw new ToolError("each attachment needs a name, like report.pdf");
    let mediaType = typeof a.media_type === "string" && a.media_type.trim() ? a.media_type.trim() : mediaTypeOf(name);
    let bytes: Uint8Array;
    if (typeof a.text === "string") {
      bytes = new TextEncoder().encode(a.text);
      if (mediaType === "application/octet-stream") mediaType = "text/plain";
    } else if (typeof a.data_base64 === "string") {
      try {
        bytes = fromB64(a.data_base64);
      } catch {
        throw new ToolError(`${name}: data_base64 isn't valid base64`);
      }
    } else if (typeof a.url === "string") {
      let u: URL;
      try {
        u = new URL(a.url);
      } catch {
        throw new ToolError(`${name}: url isn't a URL`);
      }
      if (u.protocol !== "https:") throw new ToolError(`${name}: url must be https`);
      const res = await fetch(u.toString(), { redirect: "follow" });
      if (!res.ok) throw new ToolError(`${name}: fetching it answered ${res.status}`);
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > FILE_MAX) throw new ToolError(`${name} is ${size(len)}; the limit is ${size(FILE_MAX)} a file`);
      bytes = new Uint8Array(await res.arrayBuffer());
      const type = res.headers.get("content-type")?.split(";")[0]?.trim();
      if (!(typeof a.media_type === "string" && a.media_type.trim()) && type) mediaType = type;
    } else {
      throw new ToolError(`${name}: give text, data_base64 or url`);
    }
    if (bytes.length === 0) throw new ToolError(`${name} is empty`);
    if (bytes.length > FILE_MAX) throw new ToolError(`${name} is ${size(bytes.length)}; the limit is ${size(FILE_MAX)} a file`);
    total += bytes.length;
    if (total > FILES_MAX) throw new ToolError(`the attachments are over ${size(FILES_MAX)} in all`);
    out.push({ name, mediaType, data: b64(bytes) });
  }
  return out;
}

// --- shared actions ----------------------------------------------------------------------

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto"] as const satisfies readonly PermissionMode[];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Applies the optional settings in args (before the first prompt, for workspace). */
async function configure(ctx: ToolContext, d: Device, threadId: string, args: Args, withWorkspace: boolean): Promise<void> {
  const p: AgentMethods["agent.configure"][0] = { threadId };
  const workspace = withWorkspace ? oneOf(args, "workspace", ["local", "worktree"] as const) : undefined;
  if (workspace) Object.assign(p, { workspace, baseBranch: str(args, "base_branch") ?? "" });
  const model = str(args, "model");
  if (model !== undefined) p.model = model === "default" ? "" : model;
  const mode = oneOf(args, "permission_mode", PERMISSION_MODES);
  if (mode) p.mode = mode;
  const effort = oneOf(args, "effort", EFFORTS);
  if (effort) p.effort = effort;
  const thinking = bool(args, "thinking");
  if (thinking !== undefined) p.thinking = thinking;
  if (Object.keys(p).length > 1) await call(ctx, d, "agent.configure", p, 60_000);
}

/** Sends a prompt, then waits up to wait for the turn and shows what followed. */
async function sendAndRead(ctx: ToolContext, d: Device, threadId: string, text: string, files: AgentFile[], wait: number): Promise<string> {
  const start = await call(ctx, d, "agent.read", { threadId, limit: 1 });
  await call(ctx, d, "agent.send", { threadId, text, ...(files.length ? { files } : {}) }, 90_000);
  const page = await pageForward(ctx, d, threadId, { seq: start.lastSeq, part: 1 }, PAGE_DEFAULT, "messages", wait);
  return formatPage(ctx.env, d, page, false);
}

// --- schemas ----------------------------------------------------------------------------------

const deviceArg = { type: "string", description: "Device id or name (from list_devices)." };
const threadArg = { type: "string", description: "Thread id (or its exact name)." };
const optionalDevice = { type: "string", description: "Device id or name. Optional: without it, every device this key reaches is checked." };
const waitArg = (fallback: number) => ({
  type: "number",
  description: `How long to wait for Claude to finish its turn or stop on a question before returning, in seconds (0-${WAIT_MAX_S}, default ${fallback}).`,
});
const attachmentsArg = {
  type: "array",
  description: `Files to send with the prompt (at most 10; ${size(FILE_MAX)} each, ${size(FILES_MAX)} in all). Images are shown to Claude; other files are saved where it can open them.`,
  items: {
    type: "object",
    properties: {
      name: { type: "string", description: "File name with extension, e.g. screenshot.png or spec.md." },
      text: { type: "string", description: "The file's content, for text files." },
      data_base64: { type: "string", description: "The file's bytes, base64, for binary files." },
      url: { type: "string", description: "An https URL to download the file from instead." },
      media_type: { type: "string", description: "e.g. image/png. Guessed from the name when left out." },
    },
    required: ["name"],
  },
};
const settingsArgs = {
  model: { type: "string", description: 'Claude model, e.g. "opus", "sonnet", or "default".' },
  permission_mode: {
    type: "string",
    enum: PERMISSION_MODES,
    description:
      "What Claude may do without asking the user: default (asks before edits and commands), acceptEdits, plan (plans first, changes nothing), auto. Skipping prompts entirely isn't available here.",
  },
  effort: { type: "string", enum: EFFORTS, description: "Reasoning effort, for models that support it." },
  thinking: { type: "boolean", description: "Extended thinking on or off." },
};

const read = { readOnlyHint: true, openWorldHint: false } as const;
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

// --- tools ------------------------------------------------------------------------------------

export const tools: Tool[] = [
  {
    name: "list_devices",
    title: "List devices",
    scope: "read",
    description: "The machines this key can reach, and whether each is online and new enough. A device must also allow connected agents (the user turns that on in everywhere).",
    inputSchema: { type: "object", properties: {} },
    annotations: read,
    async run(ctx) {
      const devices = await listDevices(ctx);
      if (!devices.length) return "This key can't reach any device (they were removed).";
      return devices
        .map((d) => `- ${d.name} (device ${d.id}) · ${d.os}/${d.arch} · ${!d.online ? "offline" : d.capable ? "online" : "online, but its everywhere is too old for connected agents"}`)
        .join("\n");
    },
  },
  {
    name: "list_projects",
    title: "List projects",
    scope: "read",
    description:
      "Projects (folders) on a device, or on every device this key reaches. Each device has Scratch, for work outside any project: each thread started there gets a fresh folder of its own.",
    inputSchema: { type: "object", properties: { device: { ...optionalDevice } } },
    annotations: read,
    async run(ctx, args) {
      const { devices, skipped } = await targetDevices(ctx, args.device);
      const out: string[] = [];
      await Promise.all(
        devices.map(async (d) => {
          const [projects, threads] = await Promise.all([call(ctx, d, "projects.list", {}), call(ctx, d, "threads.list", {})]);
          out.push(
            `${d.name} (device ${d.id}):`,
            ...projects.map((p) => {
              const n = threads.filter((t) => t.projectId === p.id && !t.archivedAt).length;
              return `- ${p.isScratch ? "Scratch" : p.name} project_id=${p.id} · ${p.path} · ${n} thread${n === 1 ? "" : "s"}${p.isHome ? " · home" : ""}`;
            }),
          );
        }),
      );
      if (skipped.length) out.push("", `Not reachable: ${skipped.map(unavailable).join("; ")}`);
      return out.join("\n") || "No projects.";
    },
  },
  {
    name: "list_threads",
    title: "List threads",
    scope: "read",
    description:
      "Threads (Claude conversations, other agents' and terminals) with their status, most recently active first. Filter by device, project, status or name; page with offset.",
    inputSchema: {
      type: "object",
      properties: {
        device: { ...optionalDevice },
        project: { type: "string", description: "Project id or name (needs device if the name is on several)." },
        status: { type: "string", enum: ["working", "waiting", "idle", "stopped", "done", "error", "archived"], description: "Only threads in this state." },
        name: { type: "string", description: "Only threads whose name contains this." },
        include_archived: { type: "boolean", description: "Include archived threads (default false)." },
        limit: { type: "number", description: "Default 30, at most 100." },
        offset: { type: "number", description: "Skip this many (for the next page)." },
      },
    },
    annotations: read,
    async run(ctx, args) {
      const projectRef = str(args, "project")?.toLowerCase();
      const status = str(args, "status");
      const name = str(args, "name")?.toLowerCase();
      const archived = bool(args, "include_archived") ?? status === "archived";
      const limit = Math.min(Math.max(Math.floor(num(args, "limit") ?? 30), 1), 100);
      const offset = Math.max(Math.floor(num(args, "offset") ?? 0), 0);
      const { devices, skipped } = await targetDevices(ctx, args.device);
      const rows = (
        await Promise.all(
          devices.map(async (d) => {
            const [projects, list] = await Promise.all([call(ctx, d, "projects.list", {}), call(ctx, d, "threads.list", {})]);
            const byId = new Map(projects.map((p) => [p.id, p]));
            return list
              .filter((t) => {
                const p = byId.get(t.projectId);
                if (projectRef && !(t.projectId === projectRef || p?.name.toLowerCase() === projectRef || (projectRef === "scratch" && p?.isScratch))) return false;
                if (!archived && t.archivedAt) return false;
                if (status && threadStatus(t) !== status) return false;
                if (name && !t.name.toLowerCase().includes(name)) return false;
                return true;
              })
              .map((t) => ({ at: t.lastOpenedAt ?? t.createdAt, line: threadLine(d, t, byId.get(t.projectId)) }));
          }),
        )
      ).flat();
      rows.sort((a, b) => b.at - a.at);
      const page = rows.slice(offset, offset + limit);
      const out = page.length ? page.map((r) => r.line) : ["No threads match."];
      if (offset + limit < rows.length) out.push("", `${rows.length - offset - limit} more: list_threads with offset=${offset + limit}.`);
      if (skipped.length) out.push("", `Not reachable: ${skipped.map(unavailable).join("; ")}`);
      return out.join("\n");
    },
  },
  {
    name: "search_threads",
    title: "Search threads",
    scope: "read",
    description: "Search threads by name and by the words of their prompts and replies, on one device or every device this key reaches. Newest match first.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words that must all appear." },
        device: { ...optionalDevice },
        limit: { type: "number", description: "Default 20, at most 50." },
      },
      required: ["query"],
    },
    annotations: read,
    async run(ctx, args) {
      const query = str(args, "query", true);
      const limit = Math.min(Math.max(Math.floor(num(args, "limit") ?? 20), 1), 50);
      const { devices, skipped } = await targetDevices(ctx, args.device);
      const hits: { at: number; text: string }[] = [];
      await Promise.all(
        devices.map(async (d) => {
          const [projects, list, found] = await Promise.all([
            call(ctx, d, "projects.list", {}),
            call(ctx, d, "threads.list", {}),
            call(ctx, d, "threads.search", { query, limit }),
          ]);
          const byId = new Map(list.map((t) => [t.id, t]));
          const project = new Map(projects.map((p) => [p.id, p]));
          for (const h of found) {
            const t = byId.get(h.threadId);
            if (!t) continue;
            hits.push({ at: h.at, text: `${threadLine(d, t, project.get(t.projectId))}${h.snippet ? `\n    "${clip(h.snippet, 300)}"` : ""}` });
          }
        }),
      );
      hits.sort((a, b) => b.at - a.at);
      const out = hits.slice(0, limit).map((h) => h.text);
      if (!out.length) out.push("Nothing found.");
      if (skipped.length) out.push("", `Not searched: ${skipped.map(unavailable).join("; ")}`);
      return out.join("\n");
    },
  },
  {
    name: "read_thread",
    title: "Read a thread",
    scope: "read",
    description:
      "Read an agent thread's conversation in pages, with what it's doing now and anything it's waiting on the user for. " +
      "With no cursor: the newest page. Then page back with before=<cursor> until there's no older one. " +
      "To follow along: after=<cursor> returns what came after it, oldest first; with wait_seconds it first waits for Claude to finish its turn. " +
      'detail "messages" (default) shows prompts, replies and shared files; "full" adds every tool call and result. ' +
      "Files are listed with an attachment_id for get_attachment. Messages too long for one page come in parts.",
    inputSchema: {
      type: "object",
      properties: {
        thread: threadArg,
        device: { ...optionalDevice },
        before: { type: "string", description: "A cursor: show what came before it." },
        after: { type: "string", description: "A cursor: show what came after it." },
        detail: { type: "string", enum: ["messages", "full"], description: "Default messages." },
        max_chars: { type: "number", description: `Page size (default ${PAGE_DEFAULT}, at most ${PAGE_MAX}).` },
        wait_seconds: waitArg(0),
      },
      required: ["thread"],
    },
    annotations: read,
    async run(ctx, args) {
      const { d, thread } = await resolveThread(ctx, args.device, args.thread);
      if (thread.kind === "terminal") throw new ToolError(`"${thread.name}" is a terminal; connected agents can't read terminals`);
      const detail = oneOf(args, "detail", ["messages", "full"] as const) ?? "messages";
      const budget = Math.min(Math.max(Math.floor(num(args, "max_chars") ?? PAGE_DEFAULT), 2000), PAGE_MAX);
      const older = parseCursor(args, "before");
      const newer = parseCursor(args, "after");
      if (older && newer) throw new ToolError("pass before or after, not both");
      const wait = waitMs(args, 0);
      const page = newer
        ? await pageForward(ctx, d, thread.id, newer, budget, detail, wait)
        : await pageBack(ctx, d, thread.id, older, budget, detail, wait);
      return formatPage(ctx.env, d, page, true);
    },
  },
  {
    name: "get_attachment",
    title: "Get a file from a thread",
    scope: "read",
    description: `A file in a thread (one sent with a prompt, or one Claude shared), by the attachment_id read_thread lists. Images come back as images, text as text, anything else as a file. Up to ${size(FILE_MAX)}.`,
    inputSchema: {
      type: "object",
      properties: { thread: threadArg, device: { ...optionalDevice }, attachment_id: { type: "string" } },
      required: ["thread", "attachment_id"],
    },
    annotations: read,
    async run(ctx, args) {
      const { d, thread } = await resolveThread(ctx, args.device, args.thread);
      const r = await call(ctx, d, "agent.file", { threadId: thread.id, id: str(args, "attachment_id", true) }, 60_000);
      const a = r.attachment;
      const label: Content = { type: "text", text: `${a.name} (${a.mediaType}, ${size(a.size)}) from "${thread.name}"` };
      if (a.mediaType.startsWith("image/") && a.mediaType !== "image/svg+xml") {
        return [label, { type: "image", data: r.data, mimeType: a.mediaType }];
      }
      if (isText(a.mediaType) || a.mediaType === "image/svg+xml") {
        return [label, { type: "text", text: clip(new TextDecoder().decode(fromB64(r.data)), 200_000) }];
      }
      return [
        label,
        { type: "resource", resource: { uri: `everywhere://${d.id}/threads/${thread.id}/files/${a.id}/${encodeURIComponent(a.name)}`, mimeType: a.mediaType, blob: r.data } },
      ];
    },
  },
  {
    name: "create_thread",
    title: "Start a thread",
    scope: "drive",
    description:
      "Start a Claude Code thread in a project (or in Scratch, a fresh folder of its own, when no project is given), optionally with a first prompt and files, and wait for its reply. " +
      "Claude names the thread from its first prompt when no name is given. It works under the permission mode you pick; it asks the user (not you) before anything the mode doesn't allow.",
    inputSchema: {
      type: "object",
      properties: {
        device: deviceArg,
        project: { type: "string", description: "Project id or name (from list_projects). Default: Scratch." },
        name: { type: "string" },
        message: { type: "string", description: "The first prompt." },
        attachments: attachmentsArg,
        kind: { type: "string", description: 'The agent: "claude" (default) or another agent installed on the device.' },
        workspace: {
          type: "string",
          enum: ["local", "worktree"],
          description: "Work in the project's checkout (local, default) or in a new git worktree on a branch of its own.",
        },
        base_branch: { type: "string", description: "With workspace worktree: the branch to start from (default the current one)." },
        ...settingsArgs,
        wait_seconds: waitArg(WAIT_DEFAULT_S),
      },
      required: ["device"],
    },
    annotations: write,
    async run(ctx, args) {
      const d = await resolveDevice(ctx, args.device);
      const projects = await call(ctx, d, "projects.list", {});
      const ref = str(args, "project")?.trim();
      const project = ref
        ? (projects.find((p) => p.id === ref) ?? projects.find((p) => p.name.toLowerCase() === ref.toLowerCase() || (ref.toLowerCase() === "scratch" && p.isScratch)))
        : (projects.find((p) => p.isScratch) ?? projects.find((p) => p.isHome));
      if (!project) throw new ToolError(`no project "${ref ?? "Scratch"}" on ${d.name}; see list_projects`);
      const files = await filesArg(args);
      const message = str(args, "message") ?? "";
      const thread = await call(ctx, d, "threads.create", {
        projectId: project.id,
        kind: str(args, "kind") ?? "claude",
        name: str(args, "name"),
        permissionMode: oneOf(args, "permission_mode", PERMISSION_MODES),
      });
      ctx.touched.threadId = thread.id;
      await configure(ctx, d, thread.id, { ...args, permission_mode: undefined }, true);
      const head = `Started "${thread.name}" (thread_id ${thread.id}) in ${project.isScratch ? "Scratch" : project.name} on ${d.name} (device ${d.id}).\nLink for the user: ${threadUrl(ctx.env, d.id, thread.id)}`;
      if (!message.trim() && !files.length) return `${head}\nSend it a prompt with send_message.`;
      return `${head}\n\n${await sendAndRead(ctx, d, thread.id, message, files, waitMs(args, WAIT_DEFAULT_S))}`;
    },
  },
  {
    name: "send_message",
    title: "Send a prompt",
    scope: "drive",
    description:
      "Send a prompt, with files if you like, to an agent thread (starting or resuming Claude as needed), then wait for the reply. " +
      "It's shown to the user as sent by this key. If Claude is still working when the wait ends, keep following with read_thread (after, wait_seconds). " +
      "If Claude stops to ask the user something, only the user can answer.",
    inputSchema: {
      type: "object",
      properties: {
        thread: threadArg,
        device: { ...optionalDevice },
        text: { type: "string", description: "The prompt." },
        attachments: attachmentsArg,
        wait_seconds: waitArg(WAIT_DEFAULT_S),
      },
      required: ["thread"],
    },
    annotations: write,
    async run(ctx, args) {
      const { d, thread } = await resolveThread(ctx, args.device, args.thread);
      if (thread.kind === "terminal") throw new ToolError(`"${thread.name}" is a terminal; connected agents can't type into terminals`);
      const text = str(args, "text") ?? "";
      const files = await filesArg(args);
      if (!text.trim() && !files.length) throw new ToolError("send text, attachments or both");
      return sendAndRead(ctx, d, thread.id, text, files, waitMs(args, WAIT_DEFAULT_S));
    },
  },
  {
    name: "interrupt_thread",
    title: "Stop Claude's turn",
    scope: "drive",
    description: "Stop the turn an agent thread is working on (like pressing Esc). The conversation stays; send_message continues it.",
    inputSchema: { type: "object", properties: { thread: threadArg, device: { ...optionalDevice } }, required: ["thread"] },
    annotations: { ...write, idempotentHint: true },
    async run(ctx, args) {
      const { d, thread } = await resolveThread(ctx, args.device, args.thread);
      await call(ctx, d, "agent.interrupt", { threadId: thread.id });
      return `Stopped "${thread.name}".`;
    },
  },
  {
    name: "update_thread",
    title: "Change a thread",
    scope: "drive",
    description: "Rename a thread, archive or restore it (archiving stops it; its history stays), or change its model, permission mode, effort or thinking.",
    inputSchema: {
      type: "object",
      properties: {
        thread: threadArg,
        device: { ...optionalDevice },
        name: { type: "string", description: "A new name." },
        archived: { type: "boolean", description: "true to archive, false to restore." },
        ...settingsArgs,
      },
      required: ["thread"],
    },
    annotations: { ...write, idempotentHint: true },
    async run(ctx, args) {
      const { d, thread } = await resolveThread(ctx, args.device, args.thread);
      let t = thread;
      const archived = bool(args, "archived");
      if (archived === false && t.archivedAt) t = await call(ctx, d, "threads.archive", { id: t.id, archived: false });
      const name = str(args, "name");
      if (name) t = await call(ctx, d, "threads.rename", { id: t.id, name });
      if (t.kind !== "terminal") await configure(ctx, d, t.id, args, false);
      if (archived === true && !t.archivedAt) t = await call(ctx, d, "threads.archive", { id: t.id, archived: true });
      t = await call(ctx, d, "threads.get", { threadId: t.id });
      return `Updated: ${threadLine(d, t)}`;
    },
  },
  {
    name: "list_directories",
    title: "List folders",
    scope: "projects",
    description: "The folders in a folder on a device (names only), to find a path for create_project.",
    inputSchema: {
      type: "object",
      properties: { device: deviceArg, path: { type: "string", description: 'Default "~" (the home folder).' } },
      required: ["device"],
    },
    annotations: read,
    async run(ctx, args) {
      const d = await resolveDevice(ctx, args.device);
      const r = await call(ctx, d, "fs.listDirs", { path: str(args, "path") ?? "~" });
      return [`${r.path}${r.parent ? ` (parent: ${r.parent})` : ""}:`, ...r.dirs.map((x) => `- ${x}`)].join("\n");
    },
  },
  {
    name: "create_project",
    title: "Add a project",
    scope: "projects",
    description: "Add a folder on a device as a project, so threads can work in it. The folder must exist.",
    inputSchema: {
      type: "object",
      properties: {
        device: deviceArg,
        path: { type: "string", description: 'Absolute, or starting with "~/".' },
        name: { type: "string", description: "Default: the folder's name." },
      },
      required: ["device", "path"],
    },
    annotations: write,
    async run(ctx, args) {
      const d = await resolveDevice(ctx, args.device);
      const p = await call(ctx, d, "projects.create", { path: str(args, "path", true), name: str(args, "name") });
      return `Added project "${p.name}" project_id=${p.id} at ${p.path} on ${d.name}.`;
    },
  },
];
