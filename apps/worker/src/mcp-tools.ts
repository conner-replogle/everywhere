// The MCP endpoint's tools. Each one resolves a device, then relays requests
// to its daemon through the AccountHub (see RemoteMethods in the protocol).
import type {
  AgentClientMsg,
  AgentEvent,
  AgentRead,
  AgentState,
  Project,
  RemoteMethod,
  RemoteMethods,
  Thread,
} from "@everywhere/protocol";
import type { DeviceRpcResult } from "./hub";

export class ToolError extends Error {}

export interface ToolContext {
  env: Env;
  accountId: string;
}

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
  run(ctx: ToolContext, args: Args): Promise<unknown>;
}

const WAIT_DEFAULT_S = 30;
const WAIT_MAX_S = 50;
/** Keeps a transcript well inside what a model wants to read in one go. */
const TRANSCRIPT_MAX_CHARS = 60_000;

// --- devices and rpc ------------------------------------------------------------

interface Device {
  id: string;
  name: string;
  hostname: string;
  os: string;
  arch: string;
  version: string;
  lastSeenAt: number | null;
  online: boolean;
  /** Online with a daemon new enough to be driven from here. */
  reachable: boolean;
}

function hub(ctx: ToolContext) {
  return ctx.env.HUB.get(ctx.env.HUB.idFromName(ctx.accountId));
}

async function listDevices(ctx: ToolContext): Promise<Device[]> {
  const [{ results }, online] = await Promise.all([
    ctx.env.DB.prepare(
      `SELECT id, name, hostname, os, arch, version, last_seen_at AS lastSeenAt
       FROM devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY name`,
    )
      .bind(ctx.accountId)
      .all<Omit<Device, "online" | "reachable">>(),
    hub(ctx).devices(),
  ]);
  const status = new Map(online.map((d) => [d.id, d.rpc]));
  return results.map((d) => ({ ...d, online: status.has(d.id), reachable: status.get(d.id) === true }));
}

/** A device by id, or by name or hostname (case-insensitive). */
async function resolveDevice(ctx: ToolContext, ref: unknown): Promise<Device> {
  if (typeof ref !== "string" || !ref.trim()) throw new ToolError("device_id is required");
  const devices = await listDevices(ctx);
  const want = ref.trim().toLowerCase();
  const d =
    devices.find((x) => x.id === ref.trim()) ??
    devices.find((x) => x.name.toLowerCase() === want) ??
    devices.find((x) => x.hostname.toLowerCase() === want);
  if (!d) {
    const names = devices.map((x) => `${x.name} (${x.id})`).join(", ") || "none";
    throw new ToolError(`no device "${ref}"; devices: ${names}`);
  }
  return d;
}

/** Devices to fan out to: one if named, else every reachable one. */
async function targetDevices(ctx: ToolContext, ref: unknown): Promise<{ devices: Device[]; skipped: Device[] }> {
  if (typeof ref === "string" && ref.trim()) return { devices: [await resolveDevice(ctx, ref)], skipped: [] };
  const all = await listDevices(ctx);
  return { devices: all.filter((d) => d.reachable), skipped: all.filter((d) => !d.reachable) };
}

async function call<M extends RemoteMethod>(
  ctx: ToolContext,
  device: Device,
  method: M,
  params: RemoteMethods[M][0],
  timeoutMs?: number,
): Promise<RemoteMethods[M][1]> {
  // Typed by hand: narrowing doesn't survive the stub's RPC types.
  const r = (await hub(ctx).deviceRpc(device.id, method, params, timeoutMs)) as DeviceRpcResult<RemoteMethods[M][1]>;
  if (r.ok) return r.result;
  throw new ToolError(`${device.name}: ${r.message}`);
}

function unavailable(d: Device): { device: string; deviceId: string; reason: string } {
  return {
    device: d.name,
    deviceId: d.id,
    reason: d.online ? "its daemon is too old to be controlled from here; update it" : "offline",
  };
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

function waitMs(args: Args, fallbackS = WAIT_DEFAULT_S): number {
  const s = num(args, "wait_seconds") ?? fallbackS;
  return Math.max(0, Math.min(s, WAIT_MAX_S)) * 1000;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- links and summaries ------------------------------------------------------------

function threadUrl(env: Env, deviceId: string, threadId: string): string {
  return `${env.PUBLIC_URL}/d/${deviceId}/t/${threadId}`;
}

function iso(ms: number | null | undefined): string | undefined {
  return ms ? new Date(ms).toISOString() : undefined;
}

function threadStatus(t: Thread): string {
  if (t.archivedAt) return "archived";
  if (t.kind === "claude") return t.agentStatus ?? "stopped";
  return t.running ? "running" : "not started";
}

function threadSummary(env: Env, d: Device, t: Thread, project?: Project) {
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    status: threadStatus(t),
    deviceId: d.id,
    device: d.name,
    projectId: t.projectId,
    project: project?.name,
    lastOpenedAt: iso(t.lastOpenedAt),
    createdAt: iso(t.createdAt),
    ...(t.worktree ? { worktree: t.worktree } : {}),
    url: threadUrl(env, d.id, t.id),
  };
}

// --- transcripts ---------------------------------------------------------------------

function clip(s: string, max: number): string {
  s = s.trim();
  return s.length > max ? `${s.slice(0, max)}… [${s.length - max} more chars]` : s;
}

function inputOf(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function toolLine(name: string, input: unknown): string {
  const i = inputOf(input);
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
        ? i.todos.map((t) => `${inputOf(t).status === "completed" ? "[x]" : "[ ]"} ${String(inputOf(t).content ?? "")}`).join("; ")
        : "";
    case "ExitPlanMode":
      return clip(s("plan"), 4000);
  }
  return clip(JSON.stringify(input) ?? "", 300);
}

function eventLines(seq: number, ev: AgentEvent): string | null {
  // A subagent's own steps; its result shows on the parent's tool call.
  if (ev.parentId) return null;
  switch (ev.type) {
    case "user": {
      const files = ev.attachments?.length ? ` [attached: ${ev.attachments.map((a) => a.name).join(", ")}]` : "";
      return `#${seq} USER:\n${ev.text}${files}`;
    }
    case "assistant":
      return `#${seq} CLAUDE:\n${ev.text}`;
    case "thinking":
      return null;
    case "tool":
      return `#${seq} tool ${ev.name}: ${toolLine(ev.name, ev.input)}`;
    case "toolResult":
      return ev.isError ? `#${seq}   ↳ error: ${clip(ev.output, 600)}` : `#${seq}   ↳ ${clip(ev.output, 400)}`;
    case "request": {
      const answers = ev.answers ? ` ${JSON.stringify(ev.answers)}` : "";
      return `#${seq} ${ev.kind === "tool" ? "permission" : ev.kind} for ${ev.toolName}: ${ev.decision}${answers}${ev.text ? ` (${ev.text})` : ""}`;
    }
    case "turn": {
      if (ev.status === "started") return null;
      const bits = [
        ev.durationMs ? `${Math.round(ev.durationMs / 1000)}s` : "",
        ev.costUsd ? `$${ev.costUsd.toFixed(2)}` : "",
      ].filter(Boolean);
      return `#${seq} — turn ${ev.status}${bits.length ? ` (${bits.join(", ")})` : ""}${ev.text && ev.status !== "completed" ? `: ${ev.text}` : ""} —`;
    }
    case "notice":
      return `#${seq} notice: ${ev.text}`;
    case "commandOutput":
      return `#${seq} command output:\n${clip(ev.text, 2000)}`;
  }
  return null;
}

function pendingLines(state: AgentState): string[] {
  if (state.pending.length === 0) return [];
  const out = ["", "WAITING FOR AN ANSWER (use respond_to_request):"];
  for (const r of state.pending) {
    const options =
      r.kind === "question"
        ? 'decision "allow" with answers {"<question text>": "<chosen option label or free text>"}, or "deny"'
        : `decision "allow"${r.canAllowSession ? ', "allowSession" (allow this for the rest of the session)' : ""} or "deny" (with an optional message telling Claude what to do instead)`;
    const input =
      r.kind === "plan"
        ? clip(String(inputOf(r.input).plan ?? ""), 8000)
        : clip(JSON.stringify(r.kind === "question" ? inputOf(r.input).questions : r.input, null, 1) ?? "", 4000);
    out.push(
      `- request_id ${r.id}: ${r.kind === "tool" ? `permission to use ${r.toolName}` : r.kind === "plan" ? "approve this plan" : "question"}` +
        `${r.title ? ` (${r.title})` : ""}${r.decisionReason ? ` because ${r.decisionReason}` : ""}`,
      `  ${input.replaceAll("\n", "\n  ")}`,
      `  Options: ${options}`,
    );
  }
  return out;
}

function formatAgent(env: Env, d: Device, read: AgentRead, heading = true): string {
  const { thread, state } = read;
  const lines: string[] = [];
  if (heading) {
    lines.push(`Claude thread "${thread.name}" (id ${thread.id}) on ${d.name} (device_id ${d.id})`);
    lines.push(`Link: ${threadUrl(env, d.id, thread.id)}`);
  }
  const model = state.activeModel || state.model || "default";
  const ws =
    state.workspace.mode === "worktree"
      ? `worktree${state.workspace.branch ? ` on branch ${state.workspace.branch}` : ""}${state.workspace.path ? ` at ${state.workspace.path}` : ""}`
      : "project checkout";
  lines.push(
    `Status: ${thread.archivedAt ? "archived" : state.status}${state.error ? ` (${state.error})` : ""} · model ${model} · ` +
      `permission mode ${state.permissionMode} · ${ws}` +
      (state.context ? ` · context ${Math.round(state.context.percentage)}% full` : ""),
  );

  const body: string[] = [];
  for (const e of read.events) {
    const l = eventLines(e.seq, e.event);
    if (l) body.push(l);
  }
  let clipped = false;
  let total = body.reduce((n, l) => n + l.length + 2, 0);
  while (total > TRANSCRIPT_MAX_CHARS && body.length > 1) {
    total -= body.shift()!.length + 2;
    clipped = true;
  }
  if (read.events.length === 0) {
    lines.push("", "(no messages yet)");
  } else {
    const first = read.events[0]!.seq;
    if (read.more || clipped) {
      lines.push("", `(older messages not shown; read_thread with before_seq=${first} for earlier ones)`);
    }
    lines.push("", body.join("\n\n"));
  }
  const streaming = state.streaming.filter((s) => s.kind === "text" && s.text.trim());
  if (streaming.length) {
    lines.push("", `CLAUDE (still writing):\n${clip(streaming.map((s) => s.text).join("\n"), 4000)}`);
  }
  lines.push(...pendingLines(state));
  if (state.status === "working" || state.status === "starting") {
    lines.push("", `Claude is still working. Call read_thread with after_seq=${read.lastSeq} and wait_seconds to wait for more.`);
  }
  if (state.suggestion) lines.push("", `Suggested next prompt: ${state.suggestion}`);
  return lines.join("\n");
}

async function readTerminal(ctx: ToolContext, d: Device, thread: Thread, maxChars: number, heading = true): Promise<string> {
  const r = await call(ctx, d, "term.read", { threadId: thread.id, maxBytes: maxChars });
  const lines: string[] = [];
  if (heading) {
    lines.push(`Terminal thread "${thread.name}" (id ${thread.id}) on ${d.name} (device_id ${d.id})`);
    lines.push(`Link: ${threadUrl(ctx.env, d.id, thread.id)}`);
  }
  lines.push(`Status: ${threadStatus(r.thread)}`);
  if (!r.thread.running) {
    lines.push("", "(no shell running; send_message starts one)");
  } else {
    lines.push("", r.truncated ? "Recent output (older output cut):" : "Output:", "```", r.output.trimEnd(), "```");
  }
  return lines.join("\n");
}

// --- shared actions ---------------------------------------------------------------------

async function getThread(ctx: ToolContext, d: Device, threadId: string): Promise<Thread> {
  return call(ctx, d, "threads.get", { threadId });
}

async function agentRequest(ctx: ToolContext, d: Device, threadId: string, msg: AgentClientMsg) {
  await call(ctx, d, "agent.request", { threadId, msg }, 90_000);
}

/** Does something to a claude thread, then waits for and shows what followed. */
async function actAndRead(
  ctx: ToolContext,
  d: Device,
  threadId: string,
  act: () => Promise<void>,
  wait: number,
): Promise<string> {
  const before = await call(ctx, d, "agent.read", { threadId, limit: 1 });
  await act();
  const after = await call(
    ctx,
    d,
    "agent.read",
    { threadId, afterSeq: before.lastSeq, limit: 500, waitMs: wait },
    wait + 20_000,
  );
  return formatAgent(ctx.env, d, after);
}

async function sendToTerminal(ctx: ToolContext, d: Device, thread: Thread, text: string, enter: boolean, wait: number) {
  await call(ctx, d, "term.write", { threadId: thread.id, text: enter ? `${text}\r` : text });
  await sleep(Math.min(wait, 10_000));
  return readTerminal(ctx, d, thread, 8000);
}

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Applies the optional claude settings in args (before the first prompt for workspace). */
async function applyAgentSettings(ctx: ToolContext, d: Device, threadId: string, args: Args) {
  const workspace = oneOf(args, "workspace", ["local", "worktree"] as const);
  if (workspace) await agentRequest(ctx, d, threadId, { t: "setWorkspace", workspace, baseBranch: str(args, "base_branch") ?? "" });
  const model = str(args, "model");
  if (model !== undefined) await agentRequest(ctx, d, threadId, { t: "setModel", model: model === "default" ? "" : model });
  const mode = oneOf(args, "permission_mode", PERMISSION_MODES);
  if (mode) await agentRequest(ctx, d, threadId, { t: "setMode", mode });
  const effort = oneOf(args, "effort", EFFORTS);
  if (effort) await agentRequest(ctx, d, threadId, { t: "setEffort", effort });
  const thinking = bool(args, "thinking");
  if (thinking !== undefined) await agentRequest(ctx, d, threadId, { t: "setThinking", thinking });
}

// --- schemas ----------------------------------------------------------------------------------

const deviceId = { type: "string", description: "The device's id (or its name)." };
const threadId = { type: "string", description: "The thread's id, from list_threads." };
const waitSeconds = {
  type: "number",
  description: `How long to wait for Claude to finish or ask something before returning (0-${WAIT_MAX_S}, default ${WAIT_DEFAULT_S}).`,
};
const agentSettings = {
  model: { type: "string", description: 'Claude model for a claude thread, e.g. "opus", "sonnet", or "default".' },
  permission_mode: {
    type: "string",
    enum: PERMISSION_MODES,
    description:
      "What Claude may do without asking: default (asks before edits and commands), acceptEdits, plan (plans first, no changes), auto, bypassPermissions (never asks).",
  },
  effort: { type: "string", enum: EFFORTS, description: "Reasoning effort, for models that support it." },
  thinking: { type: "boolean", description: "Extended thinking on or off." },
};

const read = { readOnlyHint: true, openWorldHint: false } as const;
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

// --- tools ------------------------------------------------------------------------------------

export const tools: Tool[] = [
  {
    name: "search",
    title: "Search threads",
    description:
      "Search every online device's projects and threads by name and by what was said in claude threads. An empty query lists the most recent threads. Returns ids for fetch.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Words to look for." } },
      required: ["query"],
    },
    annotations: read,
    async run(ctx, args) {
      const query = (typeof args.query === "string" ? args.query : "").trim();
      const q = query.toLowerCase();
      const { devices } = await targetDevices(ctx, undefined);
      const results: { id: string; title: string; url: string; snippet?: string; at: number }[] = [];
      await Promise.all(
        devices.map(async (d) => {
          const [projects, threads, hits] = await Promise.all([
            call(ctx, d, "projects.list", {}),
            call(ctx, d, "threads.list", {}),
            query ? call(ctx, d, "threads.search", { query, limit: 20 }) : Promise.resolve([]),
          ]).catch(() => [[], [], []] as [Project[], Thread[], []]);
          const byId = new Map(threads.map((t) => [t.id, t]));
          const project = new Map(projects.map((p) => [p.id, p]));
          const seen = new Set<string>();
          const add = (t: Thread, snippet?: string, at?: number) => {
            if (seen.has(t.id)) return;
            seen.add(t.id);
            results.push({
              id: `thread:${d.id}/${t.id}`,
              title: `${t.name} (${t.kind} thread in ${project.get(t.projectId)?.name ?? "?"} on ${d.name})`,
              url: threadUrl(ctx.env, d.id, t.id),
              ...(snippet ? { snippet } : {}),
              at: at ?? t.lastOpenedAt ?? t.createdAt,
            });
          };
          for (const h of hits) {
            const t = byId.get(h.threadId);
            if (t) add(t, h.snippet, h.at);
          }
          for (const t of threads) {
            const p = project.get(t.projectId);
            if (!q || t.name.toLowerCase().includes(q) || p?.name.toLowerCase().includes(q) || p?.path.toLowerCase().includes(q)) {
              if (!q && t.archivedAt) continue;
              add(t);
            }
          }
        }),
      );
      results.sort((a, b) => b.at - a.at);
      return { results: results.slice(0, 25).map(({ at: _, ...r }) => r) };
    },
  },
  {
    name: "fetch",
    title: "Fetch a thread",
    description: 'Fetch a search result by id ("thread:<device_id>/<thread_id>"): the thread\'s recent conversation or terminal output.',
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "An id from search." } },
      required: ["id"],
    },
    annotations: read,
    async run(ctx, args) {
      const id = str(args, "id", true);
      const m = /^thread:([^/]+)\/(.+)$/.exec(id);
      if (!m) throw new ToolError(`unknown id ${id}`);
      const d = await resolveDevice(ctx, m[1]);
      const thread = await getThread(ctx, d, m[2]!);
      const text =
        thread.kind === "claude"
          ? formatAgent(ctx.env, d, await call(ctx, d, "agent.read", { threadId: thread.id, limit: 150 }))
          : await readTerminal(ctx, d, thread, 32_000);
      return {
        id,
        title: thread.name,
        text,
        url: threadUrl(ctx.env, d.id, thread.id),
        metadata: { device: d.name, kind: thread.kind, status: threadStatus(thread) },
      };
    },
  },
  {
    name: "list_devices",
    title: "List devices",
    description: "The user's machines, whether each is online, and whether it can be controlled from here.",
    inputSchema: { type: "object", properties: {} },
    annotations: read,
    async run(ctx) {
      const devices = await listDevices(ctx);
      return {
        devices: devices.map((d) => ({
          id: d.id,
          name: d.name,
          hostname: d.hostname,
          platform: `${d.os}/${d.arch}`,
          daemonVersion: d.version,
          online: d.online,
          ...(d.online && !d.reachable ? { note: "daemon too old to control from here; update it" } : {}),
          lastSeenAt: iso(d.lastSeenAt),
        })),
      };
    },
  },
  {
    name: "list_projects",
    title: "List projects",
    description:
      "Projects (directories) on one device, or on every online device. Each device has a home project for its home directory.",
    inputSchema: {
      type: "object",
      properties: { device_id: { ...deviceId, description: "Only this device (id or name). Omit for all." } },
    },
    annotations: read,
    async run(ctx, args) {
      const { devices, skipped } = await targetDevices(ctx, args.device_id);
      const out = await Promise.all(
        devices.map(async (d) => {
          const [projects, threads] = await Promise.all([
            call(ctx, d, "projects.list", {}),
            call(ctx, d, "threads.list", {}),
          ]);
          return {
            deviceId: d.id,
            device: d.name,
            projects: projects.map((p) => ({
              id: p.id,
              name: p.name,
              path: p.path,
              ...(p.isHome ? { isHome: true } : {}),
              threads: threads.filter((t) => t.projectId === p.id && !t.archivedAt).length,
            })),
          };
        }),
      );
      return { devices: out, ...(skipped.length ? { unavailable: skipped.map(unavailable) } : {}) };
    },
  },
  {
    name: "list_threads",
    title: "List threads",
    description:
      "Threads (claude conversations and terminals) with their status, newest activity first. Filter by device and project.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: { ...deviceId, description: "Only this device (id or name). Omit for all." },
        project_id: { type: "string", description: "Only this project (needs device_id)." },
        include_archived: { type: "boolean", description: "Include archived threads (default false)." },
      },
    },
    annotations: read,
    async run(ctx, args) {
      const projectId = str(args, "project_id");
      if (projectId && !str(args, "device_id")) throw new ToolError("project_id needs device_id");
      const archived = bool(args, "include_archived") ?? false;
      const { devices, skipped } = await targetDevices(ctx, args.device_id);
      const threads = (
        await Promise.all(
          devices.map(async (d) => {
            const [projects, list] = await Promise.all([
              call(ctx, d, "projects.list", {}),
              call(ctx, d, "threads.list", projectId ? { projectId } : {}),
            ]);
            const byId = new Map(projects.map((p) => [p.id, p]));
            return list
              .filter((t) => archived || !t.archivedAt)
              .map((t) => ({ at: t.lastOpenedAt ?? t.createdAt, t: threadSummary(ctx.env, d, t, byId.get(t.projectId)) }));
          }),
        )
      ).flat();
      threads.sort((a, b) => b.at - a.at);
      return {
        threads: threads.map((x) => x.t),
        ...(skipped.length ? { unavailable: skipped.map(unavailable) } : {}),
      };
    },
  },
  {
    name: "read_thread",
    title: "Read a thread",
    description:
      "A claude thread's conversation (newest messages, tool calls, and any permission prompt waiting for an answer), or a terminal's recent output.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: deviceId,
        thread_id: threadId,
        limit: { type: "number", description: "Claude threads: how many of the newest log entries to show (default 60, max 500)." },
        before_seq: { type: "number", description: "Claude threads: show entries before this # (to page back)." },
        after_seq: { type: "number", description: "Claude threads: only entries after this #." },
        wait_seconds: {
          type: "number",
          description: `Claude threads: first wait up to this long for a turn in progress to finish (0-${WAIT_MAX_S}, default 0).`,
        },
        max_chars: { type: "number", description: "Terminals: how much recent output to show (default 16000)." },
      },
      required: ["device_id", "thread_id"],
    },
    annotations: read,
    async run(ctx, args) {
      const d = await resolveDevice(ctx, args.device_id);
      const thread = await getThread(ctx, d, str(args, "thread_id", true));
      if (thread.kind !== "claude") return readTerminal(ctx, d, thread, num(args, "max_chars") ?? 16_000);
      const wait = waitMs(args, 0);
      const r = await call(
        ctx,
        d,
        "agent.read",
        {
          threadId: thread.id,
          limit: num(args, "limit") ?? 60,
          beforeSeq: num(args, "before_seq"),
          afterSeq: num(args, "after_seq"),
          waitMs: wait,
        },
        wait + 20_000,
      );
      return formatAgent(ctx.env, d, r);
    },
  },
  {
    name: "send_message",
    title: "Send a message",
    description:
      "Send a prompt to a claude thread (starting or resuming Claude as needed) and wait for its reply; while it's still working, keep waiting with read_thread. For a terminal thread, types the text as a command and returns the output.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: deviceId,
        thread_id: threadId,
        text: { type: "string", description: "The prompt, or for a terminal, the command to type." },
        wait_seconds: waitSeconds,
        press_enter: { type: "boolean", description: "Terminals: press Enter after the text (default true)." },
      },
      required: ["device_id", "thread_id", "text"],
    },
    annotations: write,
    async run(ctx, args) {
      const d = await resolveDevice(ctx, args.device_id);
      const thread = await getThread(ctx, d, str(args, "thread_id", true));
      const text = str(args, "text", true);
      if (thread.archivedAt) throw new ToolError("this thread is archived; restore it with update_thread (archived: false) first");
      if (thread.kind !== "claude") {
        return sendToTerminal(ctx, d, thread, text, bool(args, "press_enter") ?? true, Math.min(waitMs(args, 2), 10_000));
      }
      return actAndRead(ctx, d, thread.id, () => agentRequest(ctx, d, thread.id, { t: "send", text }), waitMs(args));
    },
  },
  {
    name: "create_thread",
    title: "Create a thread",
    description:
      "Start a new claude thread (a Claude Code conversation in the project) or terminal in a project, optionally with a first message. Claude names the thread from its first message when no name is given.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: deviceId,
        project_id: { type: "string", description: "The project, from list_projects. Omit for the device's home project." },
        kind: { type: "string", enum: ["claude", "terminal"], description: "Default claude." },
        name: { type: "string", description: "Optional name." },
        message: { type: "string", description: "A first prompt (claude) or command (terminal) to send right away." },
        workspace: {
          type: "string",
          enum: ["local", "worktree"],
          description: "Claude threads: work in the project checkout (local, default) or in a new git worktree on its own branch.",
        },
        base_branch: { type: "string", description: "With workspace worktree: the branch to start from (default the current one)." },
        ...agentSettings,
        wait_seconds: waitSeconds,
      },
      required: ["device_id"],
    },
    annotations: write,
    async run(ctx, args) {
      const d = await resolveDevice(ctx, args.device_id);
      let projectId = str(args, "project_id");
      if (!projectId) {
        const home = (await call(ctx, d, "projects.list", {})).find((p) => p.isHome);
        if (!home) throw new ToolError("the device has no home project; pass project_id");
        projectId = home.id;
      }
      const kind = oneOf(args, "kind", ["claude", "terminal"] as const) ?? "claude";
      const thread = await call(ctx, d, "threads.create", { projectId, kind, name: str(args, "name") });
      const created = `Created ${kind} thread "${thread.name}" (thread_id ${thread.id}) on ${d.name} (device_id ${d.id}).\nLink: ${threadUrl(ctx.env, d.id, thread.id)}`;
      const message = str(args, "message");
      if (kind === "terminal") {
        if (!message) return created;
        return `${created}\n\n${await sendToTerminal(ctx, d, thread, message, true, Math.min(waitMs(args, 2), 10_000))}`;
      }
      await applyAgentSettings(ctx, d, thread.id, args);
      if (!message) return created;
      const reply = await actAndRead(ctx, d, thread.id, () => agentRequest(ctx, d, thread.id, { t: "send", text: message }), waitMs(args));
      return `${created}\n\n${reply}`;
    },
  },
  {
    name: "respond_to_request",
    title: "Answer a prompt",
    description:
      "Answer a claude thread's pending permission prompt, question or plan (shown by read_thread when its status is waiting), then wait for what Claude does next.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: deviceId,
        thread_id: threadId,
        request_id: { type: "string", description: "The request id from read_thread." },
        decision: {
          type: "string",
          enum: ["allow", "allowSession", "deny"],
          description: "allow once, allowSession (allow this kind of action for the rest of the session), or deny.",
        },
        message: { type: "string", description: "With deny: what Claude should do instead." },
        answers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Questions: each question's text mapped to the chosen option's label (or a free-text answer).",
        },
        wait_seconds: waitSeconds,
      },
      required: ["device_id", "thread_id", "request_id", "decision"],
    },
    annotations: write,
    async run(ctx, args) {
      const d = await resolveDevice(ctx, args.device_id);
      const id = str(args, "thread_id", true);
      const decision = oneOf(args, "decision", ["allow", "allowSession", "deny"] as const)!;
      const answers = args.answers;
      if (answers !== undefined && (typeof answers !== "object" || answers === null || Array.isArray(answers))) {
        throw new ToolError("answers must be an object of question -> answer");
      }
      const msg: AgentClientMsg = {
        t: "respond",
        requestId: str(args, "request_id", true),
        decision,
        message: str(args, "message"),
        answers: answers as Record<string, string> | undefined,
      };
      return actAndRead(ctx, d, id, () => agentRequest(ctx, d, id, msg), waitMs(args));
    },
  },
  {
    name: "interrupt_thread",
    title: "Stop Claude",
    description: "Stop the turn a claude thread is working on (like pressing Esc). The conversation stays; send_message continues it.",
    inputSchema: {
      type: "object",
      properties: { device_id: deviceId, thread_id: threadId },
      required: ["device_id", "thread_id"],
    },
    annotations: { ...write, idempotentHint: true },
    async run(ctx, args) {
      const d = await resolveDevice(ctx, args.device_id);
      const id = str(args, "thread_id", true);
      await agentRequest(ctx, d, id, { t: "interrupt" });
      return "Interrupted.";
    },
  },
  {
    name: "update_thread",
    title: "Update a thread",
    description:
      "Rename a thread, archive or restore it (archiving stops its shell or Claude; history stays), or change a claude thread's model, permission mode, effort or thinking.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: deviceId,
        thread_id: threadId,
        name: { type: "string", description: "A new name." },
        archived: { type: "boolean", description: "true to archive, false to restore." },
        ...agentSettings,
      },
      required: ["device_id", "thread_id"],
    },
    annotations: { ...write, idempotentHint: true },
    async run(ctx, args) {
      const d = await resolveDevice(ctx, args.device_id);
      const id = str(args, "thread_id", true);
      let thread = await getThread(ctx, d, id);
      const archived = bool(args, "archived");
      if (archived === false && thread.archivedAt) thread = await call(ctx, d, "threads.archive", { id, archived: false });
      const name = str(args, "name");
      if (name) thread = await call(ctx, d, "threads.rename", { id, name });
      if (thread.kind === "claude") await applyAgentSettings(ctx, d, id, { ...args, workspace: undefined });
      if (archived === true && !thread.archivedAt) thread = await call(ctx, d, "threads.archive", { id, archived: true });
      return { thread: threadSummary(ctx.env, d, await getThread(ctx, d, id)) };
    },
  },
  {
    name: "create_project",
    title: "Create a project",
    description: "Add a directory on a device as a project. Use list_directories to find the path.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: deviceId,
        path: { type: "string", description: 'The directory, absolute or starting with "~/". It must exist.' },
        name: { type: "string", description: "Optional name (default: the directory's name)." },
      },
      required: ["device_id", "path"],
    },
    annotations: write,
    async run(ctx, args) {
      const d = await resolveDevice(ctx, args.device_id);
      const p = await call(ctx, d, "projects.create", { path: str(args, "path", true), name: str(args, "name") });
      return { project: { id: p.id, name: p.name, path: p.path, deviceId: d.id, device: d.name } };
    },
  },
  {
    name: "list_directories",
    title: "List directories",
    description: "The subdirectories of a directory on a device (names only), for finding a project's path.",
    inputSchema: {
      type: "object",
      properties: {
        device_id: deviceId,
        path: { type: "string", description: 'Default "~" (the home directory).' },
      },
      required: ["device_id"],
    },
    annotations: read,
    async run(ctx, args) {
      const d = await resolveDevice(ctx, args.device_id);
      return call(ctx, d, "fs.listDirs", { path: str(args, "path") ?? "~" });
    },
  },
];
