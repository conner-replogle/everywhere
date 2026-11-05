// The assistant's tools. They run in this tab, over the WebRTC connections
// it already has to each device, with the same RPC the app's own views use.
// Nothing here reads files or runs commands; changing anything (prompting a
// thread, starting one) waits for the user's yes.

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Static, type TSchema, Type } from "@mariozechner/pi-ai";
import type { AgentDaemonMsg, AgentEvent, AgentState, PermissionMode } from "@everywhere/protocol";
import type { DevicePeer } from "@/lib/peer";
import {
  ago,
  type FleetDevice,
  findDevice,
  findProject,
  findThread,
  fleetDevices,
  onlineDevice,
  projectName,
  threadLine,
  threadStatus,
} from "./fleet";

export interface ToolHost {
  /** Asks the user to allow an action; resolves with their answer. */
  approve(title: string, detail?: string): Promise<boolean>;
  open(deviceId: string, threadId: string): void;
  /** Tells the assistant when the thread stops working. */
  watch(device: FleetDevice, threadId: string): string;
}

/** A long message is cut here in read_thread; read_message has all of it. */
const MESSAGE_CHARS = 6000;
const TRANSCRIPT_CHARS = 30_000;
/** read_message returns this much at a time. */
const MESSAGE_PAGE = 40_000;
/** How far back read_message looks for a message. */
const MESSAGE_LOOKBACK = 2000;
const READ_TIMEOUT_MS = 15_000;

function text(s: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: s }], details: undefined };
}

function clip(s: string, n: number): string {
  s = s.trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function tool<T extends TSchema>(
  name: string,
  label: string,
  description: string,
  parameters: T,
  run: (args: Static<T>, signal?: AbortSignal) => Promise<string>,
): AgentTool<T> {
  return { name, label, description, parameters, execute: async (_id, args, signal) => text(await run(args, signal)) };
}

/** A tool input in a few words: the path, command or pattern it's about. */
function inputSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of ["file_path", "path", "command", "pattern", "url", "query", "description", "prompt"]) {
    if (typeof o[k] === "string") return clip(o[k] as string, 140).replace(/\s+/g, " ");
  }
  return "";
}

/** Opens a thread's agent channel, replays its newest events, and closes it. */
function readAgent(
  peer: DevicePeer,
  threadId: string,
  limit: number,
  then?: (send: (msg: object) => void) => Promise<void>,
): Promise<{ events: AgentEvent[]; state: AgentState | null }> {
  return new Promise((resolve, reject) => {
    const events: AgentEvent[] = [];
    let state: AgentState | null = null;
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ch.close();
      if (err) reject(err);
      else resolve({ events, state });
    };
    const timer = setTimeout(() => finish(new Error("the device didn't answer in time")), READ_TIMEOUT_MS);
    const ch = peer.openAgent(threadId, {
      onOpen: () => ch.send({ t: "attach", limit }),
      onMessage: (m: AgentDaemonMsg) => {
        if (m.t === "event") events.push(m.event);
        else if (m.t === "state") state = m.state;
        else if (m.t === "error") finish(new Error(m.message));
        else if (m.t === "synced") {
          if (!then) return finish();
          then((msg) => ch.send(msg as never)).then(
            () => finish(),
            (e: unknown) => finish(e instanceof Error ? e : new Error(String(e))),
          );
        }
      },
      onClose: () => finish(done ? undefined : new Error("the thread's channel closed")),
    });
  });
}

/** A prompt or reply; a long one is cut, naming its id for read_message. */
function messageLine(who: string, id: string, text: string): string {
  text = text.trim();
  if (text.length <= MESSAGE_CHARS) return `${who}: ${text}`;
  return `${who} [message ${id}]: ${text.slice(0, MESSAGE_CHARS)}… (cut at ${MESSAGE_CHARS} of ${text.length} characters; read_message with this id has the rest)`;
}

/** A thread's conversation as text: only the prompts and replies. */
export function transcript(events: AgentEvent[], max = TRANSCRIPT_CHARS): string {
  const lines: string[] = [];
  for (const e of events) {
    if (e.parentId) continue; // subagents
    if (e.type === "user" && e.text) lines.push(messageLine("USER", e.id, e.text));
    else if (e.type === "assistant" && e.text.trim()) lines.push(messageLine("CLAUDE", e.id, e.text));
  }
  // Newest last; keep the newest that fit.
  const out: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i]!.length + 1;
    if (total > max) {
      out.unshift("(earlier messages left out)");
      break;
    }
    out.unshift(lines[i]!);
  }
  return out.join("\n");
}

/** What the thread is doing now, in a line (two if it's waiting on the user). */
function stateSummary(state: AgentState | null): string {
  if (!state) return "";
  const lines = [`Status: ${state.status}${state.error ? ` (${state.error})` : ""}.`];
  const r = state.pending[0];
  if (r) lines.push(`Waiting on the user: ${r.kind === "tool" ? `permission to use ${r.toolName} ${inputSummary(r.input)}` : r.kind}.`);
  return lines.join("\n");
}

const STATUSES = ["working", "waiting", "idle", "done", "error", "running", "closed", "archived"];

export function assistantTools(host: ToolHost): AgentTool<TSchema>[] {
  return [
    tool(
      "list_threads",
      "Listing threads",
      "List threads across the user's devices, with their status. Filter by device, project or status. The overview in the system prompt has the recent ones already; use this for the rest or to filter.",
      Type.Object({
        device: Type.Optional(Type.String({ description: "Device name or id." })),
        project: Type.Optional(Type.String({ description: "Project name or id." })),
        status: Type.Optional(Type.String({ description: `One of: ${STATUSES.join(", ")}.` })),
      }),
      async (a) => {
        const devices = a.device ? [findDevice(a.device)] : fleetDevices();
        const now = Date.now();
        const lines: string[] = [];
        for (const d of devices) {
          if (!d.online) {
            lines.push(`${d.name} is offline.`);
            continue;
          }
          let threads = d.threads;
          if (a.project) {
            const { project } = findProject(a.project, d.id);
            threads = threads.filter((t) => t.projectId === project.id);
          }
          if (a.status) threads = threads.filter((t) => threadStatus(t) === a.status);
          else threads = threads.filter((t) => !t.archivedAt);
          threads = [...threads].sort((x, y) => (y.lastOpenedAt ?? y.createdAt) - (x.lastOpenedAt ?? x.createdAt)).slice(0, 60);
          lines.push(...threads.map((t) => threadLine(d, t, now)));
        }
        return lines.join("\n") || "No threads match.";
      },
    ),
    tool(
      "read_thread",
      "Reading a thread",
      "Read a claude thread's recent conversation, only the user's prompts and Claude's replies, and what it's doing or waiting on now. A very long message is cut and names its id: read it whole with read_message.",
      Type.Object({
        thread: Type.String({ description: "Thread id, or its name." }),
        device: Type.Optional(Type.String({ description: "Device name or id, if the name is ambiguous." })),
        events: Type.Optional(Type.Number({ description: "How far back to read, in events, tool calls included (default 600)." })),
      }),
      async (a) => {
        const { device, thread } = findThread(a.thread, a.device);
        const d = onlineDevice(device.id);
        if (thread.kind === "terminal") return `"${thread.name}" is a terminal; its output can't be read from here.`;
        const { events, state } = await readAgent(d.peer, thread.id, Math.min(Math.max(a.events ?? 600, 20), 2000));
        const head = `"${thread.name}" in ${projectName(device, thread.projectId)} on ${device.name}, last active ${ago(thread.lastOpenedAt)}.`;
        return [head, stateSummary(state), "", transcript(events) || "(no messages yet)"].join("\n");
      },
    ),
    tool(
      "read_message",
      "Reading a message",
      "Read one prompt or reply of a claude thread in full, by the message id read_thread gives for a message it cut. Long ones come in pages: pass from to continue.",
      Type.Object({
        thread: Type.String({ description: "Thread id, or its name." }),
        device: Type.Optional(Type.String()),
        message: Type.String({ description: "The message id from read_thread." }),
        from: Type.Optional(Type.Number({ description: "The character to start at (default 0)." })),
      }),
      async (a) => {
        const { device, thread } = findThread(a.thread, a.device);
        const d = onlineDevice(device.id);
        const { events } = await readAgent(d.peer, thread.id, MESSAGE_LOOKBACK);
        const e = events.find(
          (x): x is Extract<AgentEvent, { type: "user" | "assistant" }> =>
            (x.type === "user" || x.type === "assistant") && x.id === a.message,
        );
        if (!e) {
          throw new Error(`No message ${a.message} among the thread's newest ${MESSAGE_LOOKBACK} events.`);
        }
        const all = e.text ?? "";
        const from = Math.min(Math.max(0, Math.floor(a.from ?? 0)), all.length);
        const page = all.slice(from, from + MESSAGE_PAGE);
        const end = from + page.length;
        const more = end < all.length ? `\n\n(characters ${from}-${end} of ${all.length}; pass from ${end} for the rest)` : "";
        return `${e.type === "user" ? "USER" : "CLAUDE"}: ${page}${more}`;
      },
    ),
    tool(
      "search_threads",
      "Searching threads",
      "Search every online device's threads by name and by the text of their prompts and replies.",
      Type.Object({ query: Type.String() }),
      async (a) => {
        const results: string[] = [];
        await Promise.all(
          fleetDevices()
            .filter((d) => d.online && d.peer)
            .map(async (d) => {
              try {
                const hits = await d.peer!.call("threads.search", { query: a.query, limit: 10 });
                for (const h of hits) {
                  const t = d.threads.find((x) => x.id === h.threadId);
                  if (!t) continue;
                  results.push(`${threadLine(d, t)}${h.snippet ? `\n    "${clip(h.snippet, 300)}"` : ""}`);
                }
              } catch (e) {
                results.push(`(${d.name}: search failed: ${e instanceof Error ? e.message : e})`);
              }
            }),
        );
        return results.join("\n") || "Nothing found.";
      },
    ),
    tool(
      "thread_processes",
      "Checking processes",
      "A thread's processes (dev servers, builds, test runs): status, URLs and progress. With process, that process's recent output.",
      Type.Object({
        thread: Type.String({ description: "Thread id, or its name." }),
        device: Type.Optional(Type.String()),
        process: Type.Optional(Type.String({ description: "A process name or id, to read its output." })),
        lines: Type.Optional(Type.Number({ description: "Output lines to read (default 40, at most 120)." })),
      }),
      async (a) => {
        const { device, thread } = findThread(a.thread, a.device);
        const d = onlineDevice(device.id);
        const list = await d.peer.call("processes.list", { threadId: thread.id });
        if (a.process) {
          const p = list.find((x) => x.id === a.process || x.name === a.process);
          if (!p) return `No process "${a.process}". It has: ${list.map((x) => x.name).join(", ") || "none"}.`;
          const out = await d.peer.call("processes.output", { id: p.id, tail: Math.min(a.lines ?? 40, 120) });
          return `${p.name}: ${p.status}\n${out.join("\n")}`;
        }
        if (!list.length) return "It has no processes.";
        return list
          .map((p) => {
            const urls = p.urls?.length ? ` ${p.urls.join(" ")}` : "";
            const status = p.statusText ? `${p.status} (${p.statusText})` : p.status;
            return `- ${p.name} [${p.id}]: ${status}${p.command ? ` · ${clip(p.command, 100)}` : ""}${urls}`;
          })
          .join("\n");
      },
    ),
    tool(
      "git_status",
      "Checking git",
      "The git state of a thread's checkout (or a project's): branch, ahead/behind, uncommitted changes.",
      Type.Object({
        thread: Type.Optional(Type.String({ description: "Thread id or name." })),
        project: Type.Optional(Type.String({ description: "Project name or id (with device)." })),
        device: Type.Optional(Type.String()),
      }),
      async (a) => {
        if (a.thread) {
          const { device, thread } = findThread(a.thread, a.device);
          return JSON.stringify(await onlineDevice(device.id).peer.call("git.status", { threadId: thread.id }));
        }
        if (!a.project || !a.device) throw new Error("Pass a thread, or a project and its device.");
        const { device, project } = findProject(a.project, a.device);
        return JSON.stringify(await onlineDevice(device.id).peer.call("git.status", { projectId: project.id }));
      },
    ),
    tool(
      "send_to_thread",
      "Sending to a thread",
      "Send a prompt to a claude thread, as the user. The user sees the exact text and must allow it first. Write it as the user would: complete, specific, standing on its own.",
      Type.Object({
        thread: Type.String({ description: "Thread id, or its name." }),
        device: Type.Optional(Type.String()),
        text: Type.String({ description: "The prompt." }),
      }),
      async (a) => {
        const { device, thread } = findThread(a.thread, a.device);
        const d = onlineDevice(device.id);
        if (thread.kind === "terminal") throw new Error(`"${thread.name}" is a terminal, not a claude thread.`);
        if (!(await host.approve(`Send to "${thread.name}" on ${device.name}`, a.text))) {
          return "The user said no. Nothing was sent.";
        }
        await readAgent(d.peer, thread.id, 1, async (send) => {
          send({ t: "send", text: a.text });
          await new Promise((r) => setTimeout(r, 300));
        });
        return `Sent. ${host.watch(device, thread.id)}`;
      },
    ),
    tool(
      "start_thread",
      "Starting a thread",
      "Start a new claude thread in a project with a first prompt; it starts working right away. The user sees the prompt and must allow it first. The new thread knows nothing of this conversation: the prompt must stand on its own.",
      Type.Object({
        device: Type.String({ description: "Device name or id." }),
        project: Type.String({ description: "Project name or id." }),
        prompt: Type.String(),
        name: Type.Optional(Type.String({ description: "A short thread name." })),
        mode: Type.Optional(
          Type.String({ description: "default (asks before edits and commands, the default), acceptEdits, plan or auto." }),
        ),
      }),
      async (a) => {
        const { device, project } = findProject(a.project, a.device);
        const d = onlineDevice(device.id);
        const mode = (["default", "acceptEdits", "plan", "auto"].includes(a.mode ?? "") ? a.mode : "default") as PermissionMode;
        const title = `Start a thread in ${project.name} on ${device.name}${mode === "default" ? "" : ` (${mode} mode)`}`;
        if (!(await host.approve(title, a.prompt))) return "The user said no. No thread was started.";
        const t = await d.peer.call("threads.create", {
          projectId: project.id,
          kind: "claude",
          prompt: a.prompt,
          permissionMode: mode,
          ...(a.name ? { name: a.name } : {}),
        });
        return `Started "${t.name}" [id ${t.id}]. ${host.watch(device, t.id)}`;
      },
    ),
    tool(
      "open_thread",
      "Opening a thread",
      "Show a thread in the app, on the screen the user is talking from.",
      Type.Object({ thread: Type.String(), device: Type.Optional(Type.String()) }),
      async (a) => {
        const { device, thread } = findThread(a.thread, a.device);
        host.open(device.id, thread.id);
        return `Opened "${thread.name}".`;
      },
    ),
    tool(
      "watch_thread",
      "Watching a thread",
      "Get told when a claude thread stops working (finishes, errors, or needs the user), to tell the user. Threads you send to or start are watched already.",
      Type.Object({ thread: Type.String(), device: Type.Optional(Type.String()) }),
      async (a) => {
        const { device, thread } = findThread(a.thread, a.device);
        return host.watch(device, thread.id);
      },
    ),
  ] as unknown as AgentTool<TSchema>[];
}
