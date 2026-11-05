// The assistant's agent: pi's agent loop, run in this tab, on a Workers AI
// model behind the Worker. The conversation lives in the Assistant DO
// (sync.ts); one tab at a time runs turns, and prompts from other tabs are
// sent to it. Each turn starts from the synced log, so any tab, on any
// device, picks the conversation up where it left off.

import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";
import type { AgentDaemonMsg, AgentEvent as ThreadEvent, AssistantApproval, AssistantEntry, AssistantLive } from "@everywhere/protocol";
import { useSyncExternalStore } from "react";
import { describeView, type FleetDevice, fleetDevices, fleetOverview, threadStatus } from "./fleet";
import { contextFrom, convertToLlm, messageText, userMessage } from "./messages";
import { assistantSystemPrompt, contextNote } from "./prompt";
import { cardId, MAX_CARD_MARKDOWN, SHOW_TOOL, screenNote } from "./screen";
import { assistantSync } from "./sync";
import { assistantTools } from "./tools";

export const ASSISTANT_MODELS = [
  { id: "@cf/zai-org/glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 1_000_000 },
  { id: "@cf/openai/gpt-oss-120b", name: "GPT-OSS 120B", contextWindow: 128_000 },
  { id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash", contextWindow: 1_000_000 },
  { id: "@cf/moonshotai/kimi-k2.6", name: "Kimi K2.6", contextWindow: 262_144 },
  { id: "@cf/zai-org/glm-5.3", name: "GLM 5.3", contextWindow: 1_000_000 },
] as const;
const MODEL_KEY = "ew.assistant.model";

/** Context past this many (estimated) tokens is compacted after the turn. */
const COMPACT_TOKENS = 48_000;
/** Messages kept word for word after a compaction. */
const KEEP_MESSAGES = 10;
/** Remote tabs get live text at most this often. */
const LIVE_THROTTLE_MS = 150;
/** A watch gives up after this long. */
const WATCH_MS = 3 * 60 * 60 * 1000;

export function modelId(): string {
  const id = localStorage.getItem(MODEL_KEY);
  return ASSISTANT_MODELS.some((m) => m.id === id) ? id! : ASSISTANT_MODELS[0].id;
}

export function setModelId(id: string): void {
  localStorage.setItem(MODEL_KEY, id);
}

function model(): Model<"openai-completions"> {
  const m = ASSISTANT_MODELS.find((x) => x.id === modelId()) ?? ASSISTANT_MODELS[0];
  return {
    id: m.id,
    name: m.name,
    api: "openai-completions",
    provider: "workers-ai",
    baseUrl: `${location.origin}/api/assistant/v1`,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: 8000,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    },
  };
}

function systemPrompt(): string {
  return assistantSystemPrompt(fleetOverview());
}

/** The user's words plus where they were, as the model sees them. */
export function composePrompt(text: string, opts: { voice?: boolean } = {}): string {
  const selection = (window.getSelection?.()?.toString() ?? "").trim().slice(0, 1000);
  const note = contextNote({
    view: describeView(location.pathname, location.search),
    selection,
    voice: opts.voice,
    screen: screenNote(assistantSync.getSnapshot().entries),
  });
  return `${text.trim()}\n\n${note}`;
}

const estimateTokens = (messages: AgentMessage[]) => Math.ceil(JSON.stringify(messages).length / 4);

export interface RunnerSnapshot {
  /** A turn is running in this tab. */
  busy: boolean;
  error: string | null;
  /** Replies that arrived while nobody was looking. */
  unread: number;
}

interface Watch {
  close(): void;
}

class AssistantRunner {
  private agent: Agent;
  private snap: RunnerSnapshot = { busy: false, error: null, unread: 0 };
  private listeners = new Set<() => void>();
  private live: AssistantLive = { text: "", approvals: [] };
  private liveTimer: ReturnType<typeof setTimeout> | undefined;
  private approvals = new Map<string, (allow: boolean) => void>();
  private saving: Promise<unknown>[] = [];
  private watches = new Map<string, Watch>();
  private nextApproval = 1;
  /** Shows a thread; set by the app's bridge. */
  navigate: ((deviceId: string, threadId: string) => void) | null = null;
  /** Whether someone is looking at the conversation (the panel or voice). */
  attended = false;

  constructor() {
    this.agent = new Agent({
      initialState: { systemPrompt: "", model: model(), thinkingLevel: "low", tools: [] },
      convertToLlm,
      getApiKey: () => "session",
      // Several reads at once (a rundown) run together; approvals still wait one by one.
      toolExecution: "parallel",
    });
    this.agent.state.tools = assistantTools({
      approve: (title, detail) => this.requestApproval(title, detail),
      open: (deviceId, threadId) => this.navigate?.(deviceId, threadId),
      watch: (device, threadId) => this.watch(device, threadId),
    });
    this.agent.subscribe((e) => this.onEvent(e));
    assistantSync.onSteer = (text) => void this.run(text);
    assistantSync.onApprove = (id, allow) => this.answer(id, allow);
    assistantSync.onNoRunner = (text) => {
      if (text) void this.run(text);
    };
    assistantSync.onCleared = () => this.cleared();
  }

  getSnapshot = (): RunnerSnapshot => this.snap;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private update(patch: Partial<RunnerSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  markRead(): void {
    if (this.snap.unread) this.update({ unread: 0 });
  }

  /** Sends the user's words (already composed with composePrompt). */
  async prompt(text: string): Promise<void> {
    this.update({ error: null });
    const sync = assistantSync.getSnapshot();
    // Another tab is running a turn: it takes this as its next message.
    if (sync.runner && sync.runner !== sync.me && assistantSync.steer(text)) return;
    await this.run(text);
  }

  /** Runs a turn here, or adds to the one running. */
  private async run(text: string): Promise<void> {
    const msg = userMessage(text);
    if (this.snap.busy) {
      this.agent.steer(msg);
      return;
    }
    this.update({ busy: true, error: null });
    try {
      if (!(await assistantSync.claim())) {
        if (!assistantSync.steer(text)) throw new Error("Couldn't reach the conversation. Check your connection.");
        return;
      }
      this.agent.state.model = model();
      this.agent.state.systemPrompt = systemPrompt();
      this.agent.state.messages = contextFrom(assistantSync.getSnapshot().entries);
      await this.agent.prompt(msg);
      // Steered in after the loop's last check.
      while (this.agent.hasQueuedMessages()) await this.agent.continue();
      if (this.agent.state.errorMessage) this.update({ error: this.agent.state.errorMessage });
      await Promise.allSettled(this.saving);
      await this.compactIfNeeded();
    } catch (e) {
      this.update({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.saving = [];
      for (const resolve of this.approvals.values()) resolve(false);
      this.approvals.clear();
      this.live = { text: "", approvals: [] };
      assistantSync.setLive(null);
      assistantSync.release();
      this.update({ busy: false });
    }
  }

  stop(): void {
    for (const resolve of this.approvals.values()) resolve(false);
    this.approvals.clear();
    this.agent.clearAllQueues();
    this.agent.abort();
  }

  /** The conversation was cleared: what this tab was waiting to tell it about goes too. */
  private cleared(): void {
    for (const w of [...this.watches.values()]) w.close();
    this.agent.state.messages = [];
    this.update({ unread: 0, error: null });
  }

  answer(id: string, allow: boolean): void {
    const resolve = this.approvals.get(id);
    if (!resolve) {
      // It's another tab's turn: pass it on.
      if (!assistantSync.isRunner) assistantSync.approve(id, allow);
      return;
    }
    this.approvals.delete(id);
    this.live = { ...this.live, approvals: this.live.approvals.filter((a) => a.id !== id) };
    this.publish(true);
    resolve(allow);
  }

  private requestApproval(title: string, detail?: string): Promise<boolean> {
    const approval: AssistantApproval = { id: `a${this.nextApproval++}-${Date.now()}`, title, detail };
    this.live = { ...this.live, approvals: [...this.live.approvals, approval], activity: undefined };
    this.publish(true);
    if (!this.attended) this.update({ unread: this.snap.unread + 1 });
    return new Promise((resolve) => this.approvals.set(approval.id, resolve));
  }

  private publish(now = false): void {
    if (now) {
      clearTimeout(this.liveTimer);
      this.liveTimer = undefined;
      assistantSync.setLive(this.live);
      return;
    }
    this.liveTimer ??= setTimeout(() => {
      this.liveTimer = undefined;
      assistantSync.setLive(this.live);
    }, LIVE_THROTTLE_MS);
  }

  private onEvent(e: AgentEvent): void {
    switch (e.type) {
      case "message_start":
        if ((e.message as Message).role === "assistant") {
          this.live = { ...this.live, text: "" };
          this.publish(true);
        }
        return;
      case "message_update":
        this.live = { ...this.live, text: messageText(e.message), cards: writingCards(e.message as Message) };
        this.publish();
        return;
      case "message_end": {
        const m = e.message as Message;
        this.saving.push(assistantSync.append([{ kind: "message", message: m }]).catch((err: unknown) => console.warn(err)));
        if (m.role === "assistant") {
          // The whole reply once (the voice speaks what's left of it), then it's the log's to show,
          // its cards too.
          this.live = { ...this.live, text: messageText(m) };
          this.publish(true);
          this.live = { ...this.live, text: "", cards: undefined };
          this.publish(true);
          if (!this.attended && messageText(m).trim()) this.update({ unread: this.snap.unread + 1 });
        }
        return;
      }
      case "tool_execution_start": {
        const t = this.agent.state.tools.find((x) => x.name === e.toolName);
        const about = typeof e.args?.thread === "string" ? ` ${e.args.thread}` : "";
        this.live = { ...this.live, activity: `${t?.label ?? e.toolName}${about}` };
        this.publish(true);
        return;
      }
      case "tool_execution_end":
        this.live = { ...this.live, activity: undefined };
        this.publish(true);
        return;
      default:
        return;
    }
  }

  /** Folds older messages into a summary once the context gets long. */
  private async compactIfNeeded(): Promise<void> {
    const entries = assistantSync.getSnapshot().entries;
    const context = contextFrom(entries);
    if (estimateTokens(context) < COMPACT_TOKENS) return;
    let latest = 0;
    for (const e of entries) if (e.kind === "compaction") latest = Math.max(latest, e.throughSeq);
    const messages = entries.filter((e): e is AssistantEntry & { kind: "message" } => e.kind === "message" && e.seq > latest);
    // Cut before a user message, so tool calls and their results stay together.
    let cut = messages.length - KEEP_MESSAGES;
    while (cut > 0 && (messages[cut]!.message as Message).role !== "user") cut--;
    if (cut <= 0) return;
    const older = contextFrom(entries.filter((e) => e.kind === "compaction" || e.seq <= messages[cut - 1]!.seq));
    const summary = await summarize(older);
    if (summary) await assistantSync.append([{ kind: "compaction", summary, throughSeq: messages[cut - 1]!.seq }]);
  }

  /** Watches a claude thread and tells the assistant when it stops working. */
  private watch(device: FleetDevice, threadId: string): string {
    const key = `${device.id}/${threadId}`;
    if (this.watches.has(key)) return "You'll be told when it stops working.";
    const peer = device.peer;
    if (!peer) return "Its device is offline, so it can't be watched.";
    let lastStatus = "";
    let sawWork = false;
    const events: ThreadEvent[] = [];
    const ch = peer.openAgent(threadId, {
      onOpen: () => ch.send({ t: "attach", limit: 1 }),
      onMessage: (m: AgentDaemonMsg) => {
        if (m.t === "event") events.push(m.event);
        if (m.t !== "state") return;
        const s = m.state.status;
        if (s === "working" || s === "starting") sawWork = true;
        const pending = m.state.pending.length > 0;
        if (s === lastStatus && !pending) return;
        lastStatus = s;
        if (!sawWork || s === "working" || s === "starting") return;
        // A thread started just now wasn't in the list when the watch began.
        const now = fleetDevices().find((d) => d.id === device.id);
        const name = now?.threads.find((t) => t.id === threadId)?.name ?? "the new thread";
        const what = pending ? "is waiting on the user" : s === "error" ? `failed${m.state.error ? `: ${m.state.error}` : ""}` : "finished";
        const lastReply = [...events].reverse().find((x) => x.type === "assistant" && !x.parentId);
        const reply = lastReply?.type === "assistant" ? `\nIts last reply: ${lastReply.text.slice(0, 1500)}` : "";
        stop();
        void this.run(`[Update] The thread "${name}" on ${device.name} ${what}.${reply}`);
      },
      onClose: () => stop(),
    });
    const timer = setTimeout(() => stop(), WATCH_MS);
    const stop = () => {
      clearTimeout(timer);
      this.watches.delete(key);
      ch.close();
    };
    this.watches.set(key, { close: stop });
    const thread = device.threads.find((t) => t.id === threadId);
    return thread && threadStatus(thread) === "waiting"
      ? "It's waiting on the user right now."
      : "You'll be told when it stops working.";
  }
}

/** The cards a streaming reply is writing: its show_on_screen calls so far, as far as they've come. */
function writingCards(m: Message): { id: string; markdown: string }[] | undefined {
  if (m.role !== "assistant") return undefined;
  const cards = m.content.flatMap((b) => {
    if (b.type !== "toolCall" || b.name !== SHOW_TOOL) return [];
    const a = (b.arguments ?? {}) as { id?: unknown; markdown?: unknown };
    const markdown = typeof a.markdown === "string" ? a.markdown.slice(0, MAX_CARD_MARKDOWN) : "";
    return markdown.trim() ? [{ id: cardId(a.id), markdown }] : [];
  });
  return cards.length ? cards : undefined;
}

/** One model call that writes the summary a compaction keeps. */
async function summarize(messages: AgentMessage[]): Promise<string> {
  const lines = (messages as Message[]).map((m) => {
    if (m.role === "toolResult") return `TOOL RESULT (${m.toolName}): ${messageText(m).slice(0, 1500)}`;
    if (m.role === "assistant") {
      const calls = m.content.filter((b) => b.type === "toolCall").map((b) => (b.type === "toolCall" ? `${b.name}(${JSON.stringify(b.arguments)})` : ""));
      return `ASSISTANT: ${messageText(m)}${calls.length ? ` [called ${calls.join(", ")}]` : ""}`;
    }
    return `USER: ${messageText(m)}`;
  });
  const res = await fetch("/api/assistant/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: modelId(),
      max_tokens: 4000,
      messages: [
        {
          role: "system",
          content:
            "You summarize a long conversation between a user and their assistant, for the assistant to read instead of the conversation. Keep: what the user wants and prefers, decisions made, which projects, threads (with their ids and devices) and devices came up and what's known about each, things the user asked to be told about or to do later, and open questions. Drop small talk and anything that no longer matters. Plain prose and short lists, at most 600 words. Reply with only the summary.",
        },
        { role: "user", content: lines.join("\n\n").slice(-200_000) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`summary failed (${res.status})`);
  const out = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return out.choices?.[0]?.message?.content?.trim() ?? "";
}

export const assistantRunner = new AssistantRunner();

export function useAssistantRunner(): RunnerSnapshot {
  return useSyncExternalStore(assistantRunner.subscribe, assistantRunner.getSnapshot);
}
