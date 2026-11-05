// The assistant's tools. They run in this tab, over the WebRTC connections
// it already has to each device, with the same RPC the app's own views use.
// Nothing here reads files or runs commands; changing anything (prompting a
// thread, starting one) waits for the user's yes.

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Static, type TSchema, Type } from "@mariozechner/pi-ai";
import type { AgentEvent, AgentState, PermissionMode } from "@everywhere/protocol";
import { readAgent } from "@/lib/agent-read";
import { CLEAR_TOOL, cardId, MAX_CARD_MARKDOWN, SHOW_TOOL } from "./screen";
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

/** read_thread returns the conversation this much at a time. */
export const PAGE_CHARS = 30_000;
/** How far back read_thread reads, in events (tool calls count). */
const THREAD_EVENTS = 3000;

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

/**
 * A thread's conversation as pages of text, newest first: only the prompts
 * and replies, each whole. One too long for a page is split into parts, so
 * every page fits in pageChars and nothing is left out.
 */
export function transcriptPages(events: AgentEvent[], pageChars = PAGE_CHARS): string[] {
  const units: string[] = [];
  for (const e of events) {
    if (e.parentId) continue; // subagents
    if ((e.type !== "user" && e.type !== "assistant") || !e.text?.trim()) continue;
    const who = e.type === "user" ? "USER" : "CLAUDE";
    const text = e.text.trim();
    const room = pageChars - 40; // for the part label
    if (text.length + who.length + 2 <= pageChars) {
      units.push(`${who}: ${text}`);
      continue;
    }
    const parts = Math.ceil(text.length / room);
    for (let i = 0; i < parts; i++) units.push(`${who} (part ${i + 1} of ${parts}): ${text.slice(i * room, (i + 1) * room)}`);
  }
  // Newest page first; messages in order within a page.
  const pages: string[] = [];
  let page: string[] = [];
  let size = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i]!;
    if (page.length && size + u.length + 2 > pageChars) {
      pages.push(page.join("\n\n"));
      page = [];
      size = 0;
    }
    page.unshift(u);
    size += u.length + 2;
  }
  if (page.length) pages.push(page.join("\n\n"));
  return pages;
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
      "Read a claude thread's conversation (only the user's prompts and Claude's replies, in full) and what it's doing or waiting on now. It comes in pages, newest first: page 1 is the latest messages; pass page 2, 3… for older ones. A reply too long for one page is split into parts across pages.",
      Type.Object({
        thread: Type.String({ description: "Thread id, or its name." }),
        device: Type.Optional(Type.String({ description: "Device name or id, if the name is ambiguous." })),
        page: Type.Optional(Type.Number({ description: "1 (the default) is the newest; higher is older." })),
      }),
      async (a) => {
        const { device, thread } = findThread(a.thread, a.device);
        const d = onlineDevice(device.id);
        if (thread.kind === "terminal") return `"${thread.name}" is a terminal; its output can't be read from here.`;
        const { events, state, truncated } = await readAgent(d.peer, thread.id, THREAD_EVENTS);
        const pages = transcriptPages(events);
        const n = Math.max(1, Math.floor(a.page ?? 1));
        const head = `"${thread.name}" in ${projectName(device, thread.projectId)} on ${device.name}, last active ${ago(thread.lastOpenedAt)}.`;
        if (!pages.length) return [head, stateSummary(state), "", "(no messages yet)"].join("\n");
        if (n > pages.length) return `${head}\nThere are only ${pages.length} page${pages.length === 1 ? "" : "s"}.`;
        const older =
          n < pages.length
            ? `Page ${n} of ${pages.length}. Older messages: page ${n + 1}.`
            : `Page ${n} of ${pages.length}, the oldest${truncated ? ` read (the thread has more before its newest ${THREAD_EVENTS} events)` : ""}.`;
        return [head, stateSummary(state), older, "", pages[n - 1]].join("\n");
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
      "Send a prompt to a claude thread, as the user. Only after the user said yes to this exact draft in the conversation; send the text they saw, unchanged. Otherwise they're asked to allow it first.",
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
      "Start a new claude thread in a project with a first prompt; it starts working right away. Only after the user said yes to this exact draft in the conversation; send the prompt they saw, unchanged. Otherwise they're asked to allow it first. The new thread knows nothing of this conversation: the prompt must stand on its own.",
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
      SHOW_TOOL,
      "Showing on screen",
      `Put a compact markdown card on the user's screen next to the conversation, or update the one with this id. For three or more items, steps, a checklist, a small table, a mermaid diagram, or anything to keep in view while you talk. At most ${MAX_CARD_MARKDOWN} characters.`,
      Type.Object({
        id: Type.String({ description: 'A short id saying what it is, like "decisions". Showing the same id again updates that card.' }),
        markdown: Type.String({ description: "The card: a short heading, then bullets, checkboxes, a small table or a ```mermaid diagram." }),
      }),
      async (a) => {
        const md = a.markdown.trim();
        if (!md) throw new Error("The card is empty.");
        if (md.length > MAX_CARD_MARKDOWN) {
          throw new Error(`The card is ${md.length} characters; keep it under ${MAX_CARD_MARKDOWN}. Shorten it and show it again.`);
        }
        return `On screen as "${cardId(a.id)}".`;
      },
    ),
    tool(
      CLEAR_TOOL,
      "Clearing the screen",
      "Take a card off the user's screen when the conversation has moved on from it; without an id, all of them.",
      Type.Object({ id: Type.Optional(Type.String({ description: "The card's id; leave it out to clear every card." })) }),
      async (a) => (a.id ? `Cleared "${cardId(a.id)}".` : "Cleared the screen."),
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
