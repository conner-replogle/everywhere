import type { AgentEvent, AgentStreaming } from "@everywhere/protocol";
import {
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  HistoryIcon,
  LoaderCircleIcon,
  Minimize2Icon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { memo, useState } from "react";
import type { LoggedEvent } from "@/lib/agent";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SentAttachments } from "./composer-parts";
import { Markdown } from "./markdown";
import { asInput, EditPreview, isEdit, type ToolInput, toolIcon, toolLabel, toolSummary } from "./tools";

type Ev<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>;

interface ToolItem {
  kind: "tool";
  key: number;
  tool: Ev<"tool">;
  result?: Ev<"toolResult">;
  request?: Ev<"request">;
  /** Events from the subagent this tool call started. */
  children: Item[];
}

type Item =
  | ToolItem
  /** A /recap prompt and its answer, drawn as one card. */
  | { kind: "recap"; key: number; at: number; text: string }
  | {
      kind: "event";
      key: number;
      at: number;
      event: Ev<"user" | "assistant" | "thinking" | "notice" | "request" | "turn" | "commandOutput" | "rewind">;
    };

/**
 * Folds the flat log into what's drawn: each tool call collects its result
 * and permission decision, and subagent events nest under the call that
 * started them.
 */
export function buildItems(events: LoggedEvent[]): Item[] {
  const root: Item[] = [];
  const tools = new Map<string, ToolItem>();
  // Inside a /recap turn: its prompt and bookkeeping aren't shown, its answer is the card.
  let recap: { kind: "recap"; key: number; at: number; text: string } | null = null;
  for (const { seq, at, event: e } of events) {
    const into = (e.parentId && tools.get(e.parentId)?.children) || root;
    if (e.type === "user" && !e.parentId && isRecapPrompt(e.text)) {
      recap = { kind: "recap", key: seq, at, text: "" };
      continue;
    }
    if (recap && !e.parentId) {
      if (e.type === "assistant" || e.type === "commandOutput") {
        if (!recap.text) root.push(recap);
        recap.text = recap.text ? `${recap.text}\n\n${e.text}` : e.text;
        continue;
      }
      if (e.type === "turn" && e.status !== "started") {
        recap = null;
        if (e.status === "completed") continue;
      }
    }
    switch (e.type) {
      case "tool": {
        const item: ToolItem = { kind: "tool", key: seq, tool: e, children: [] };
        tools.set(e.id, item);
        into.push(item);
        break;
      }
      case "toolResult": {
        const t = tools.get(e.id);
        if (t) t.result = e;
        break;
      }
      case "request": {
        const t = tools.get(e.toolUseId);
        // Prompts answered before claude logged the call, or canceled ones,
        // still show up on their own.
        if (t) t.request = e;
        else if (e.decision !== "canceled") root.push({ kind: "event", key: seq, at, event: e });
        break;
      }
      case "turn":
        if (e.status !== "started") root.push({ kind: "event", key: seq, at, event: e });
        break;
      default:
        into.push({ kind: "event", key: seq, at, event: e });
    }
  }
  return root;
}

export type UserEvent = Ev<"user">;

/** The prompt an automatic (or typed) recap sends. */
export const RECAP_PROMPT = "/recap";

function isRecapPrompt(text: string): boolean {
  return text.trim() === RECAP_PROMPT;
}

export const Timeline = memo(function Timeline({
  items,
  streaming,
  cwd,
  working,
  compacting,
  recapping,
  onRewind,
  onCompact,
}: {
  items: Item[];
  streaming: AgentStreaming[];
  cwd?: string;
  working: boolean;
  compacting?: boolean;
  /** The turn is only a /recap: shown quietly, its text only once it's a card. */
  recapping?: boolean;
  /** Sends /compact; offered when a turn fails because the context is full. */
  onCompact?: () => void;
  /** Offers rolling back to before a prompt; absent when the device can't. */
  onRewind?: (prompt: UserEvent) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {items.map((item) => (
        <ItemView key={item.key} item={item} cwd={cwd} onRewind={working ? undefined : onRewind} onCompact={onCompact} />
      ))}
      {recapping && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <HistoryIcon className="size-3.5 animate-pulse" />
          Recapping…
        </div>
      )}
      {!recapping &&
        streaming.map((s) =>
          s.kind === "thinking" ? (
            <Thinking key={s.key} text={s.text} live />
          ) : (
            <div key={s.key} className="leading-relaxed">
              <Markdown text={s.text} />
            </div>
          ),
        )}
      {working && !recapping && streaming.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          {compacting ? "Compacting the conversation…" : "Working…"}
        </div>
      )}
    </div>
  );
});

function ItemView({
  item,
  cwd,
  onRewind,
  onCompact,
}: {
  item: Item;
  cwd?: string;
  onRewind?: (prompt: UserEvent) => void;
  onCompact?: () => void;
}) {
  if (item.kind === "tool") return <ToolRow item={item} cwd={cwd} />;
  if (item.kind === "recap") return <RecapCard text={item.text} />;
  const e = item.event;
  switch (e.type) {
    case "user":
      return (
        <div className="group/prompt flex max-w-[85%] items-start gap-1 self-end">
          {/* Subagent prompts aren't the user's to roll back. */}
          {onRewind && !e.parentId && (
            <button
              type="button"
              title="Roll back to before this message"
              aria-label="Roll back to before this message"
              onClick={() => onRewind(e)}
              className="mt-1.5 shrink-0 rounded-md p-1 text-muted-foreground opacity-0 group-hover/prompt:opacity-100 hover:bg-secondary hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-60"
            >
              <RotateCcwIcon className="size-3.5" />
            </button>
          )}
          <div className="grid min-w-0 justify-items-end gap-1.5">
            {e.text && (
              <div className="rounded-lg bg-secondary px-3 py-2 whitespace-pre-wrap break-words">{e.text}</div>
            )}
            {e.attachments && e.attachments.length > 0 && <SentAttachments attachments={e.attachments} />}
          </div>
        </div>
      );
    case "rewind":
      return (
        <div className="text-center text-xs text-muted-foreground">
          — Rolled back
          {e.filesRestored ? `, restored ${e.filesRestored} file${e.filesRestored === 1 ? "" : "s"}` : ""} —
        </div>
      );
    case "assistant":
      return <Markdown text={e.text} className="leading-relaxed" />;
    case "thinking":
      return <Thinking text={e.text} />;
    case "notice":
      if (e.kind === "compact") {
        return (
          <div role="separator" className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            <Minimize2Icon className="size-3.5 shrink-0" />
            <span>{e.text}</span>
            <span className="h-px flex-1 bg-border" />
          </div>
        );
      }
      return <div className="text-center text-xs text-muted-foreground">— {e.text} —</div>;
    case "commandOutput":
      return <Output text={e.text} />;
    case "request":
      return <RequestLine event={e} />;
    case "turn":
      return <TurnEnd event={e} onCompact={onCompact} />;
  }
}

/** Claude's summary of where the thread stands, from /recap. */
function RecapCard({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-[13px] text-muted-foreground">
      <HistoryIcon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0">
        <span className="mr-1.5 text-xs font-medium tracking-wide text-foreground/80 uppercase">Recap</span>
        {text}
      </div>
    </div>
  );
}

function Thinking({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs hover:text-foreground"
        aria-expanded={open}
      >
        <BrainIcon className={cn("size-3.5", live && "animate-pulse")} />
        {live ? "Thinking…" : "Thought"}
        <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      {open && <Markdown text={text} className="mt-1.5 border-l-2 pl-3 text-xs italic" />}
    </div>
  );
}

function ToolRow({ item, cwd }: { item: ToolItem; cwd?: string }) {
  const { tool, result, request } = item;
  const input = asInput(tool.input);
  const Icon = toolIcon(tool.name);
  const denied = request?.decision === "deny";
  const failed = result?.isError || denied;
  // Edits and plans are the point of the call, so they start open.
  const [open, setOpen] = useState(() => isEdit(tool.name) || tool.name === "ExitPlanMode");
  const summary = toolSummary(tool.name, input, cwd);

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="group flex w-full min-w-0 items-center gap-2 rounded-md py-0.5 text-left"
      >
        <Icon className={cn("size-3.5 shrink-0", failed ? "text-destructive" : "text-muted-foreground")} />
        <span className="shrink-0 font-medium">{toolLabel(tool.name)}</span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground group-hover:text-foreground/80">
          {summary}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {denied && <span className="text-destructive">Denied</span>}
          {request?.decision === "allowSession" && <span>Allowed for session</span>}
          {item.children.length > 0 && <span>{item.children.length} steps</span>}
          {!result && !denied ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          ) : failed ? (
            <XIcon className="size-3.5 text-destructive" />
          ) : (
            <CheckIcon className="size-3.5" />
          )}
        </span>
      </button>
      {open && (
        <div className="mt-1.5 ml-5.5 grid gap-2">
          <ToolDetail name={tool.name} input={input} />
          {request?.decision === "deny" && request.text && (
            <p className="text-xs text-muted-foreground">Your feedback: {request.text}</p>
          )}
          {item.children.length > 0 && (
            <div className="flex flex-col gap-2 border-l-2 pl-3">
              {item.children.map((c) => (
                <ItemView key={c.key} item={c} cwd={cwd} />
              ))}
            </div>
          )}
          {result && showsOutput(tool.name, result.isError) && <Output text={result.output} error={result.isError} />}
          {tool.name === "AskUserQuestion" && request?.answers && (
            <ul className="text-xs">
              {Object.entries(request.answers).map(([q, a]) => (
                <li key={q}>
                  <span className="text-muted-foreground">{q}</span> → {a}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Edits show their diff and plans/questions their content; a success message adds nothing. */
function showsOutput(name: string, isError?: boolean): boolean {
  if (isError) return true;
  return !isEdit(name) && name !== "ExitPlanMode" && name !== "AskUserQuestion";
}

function ToolDetail({ name, input }: { name: string; input: ToolInput }) {
  if (isEdit(name)) return <EditPreview name={name} input={input} className="max-h-96 overflow-y-auto" />;
  if (name === "ExitPlanMode" && typeof input.plan === "string") {
    return <Markdown text={input.plan} className="rounded-md border px-3 py-2" />;
  }
  if (name === "Bash" && typeof input.command === "string") {
    return <Output text={`$ ${input.command}`} />;
  }
  if (name === "TodoWrite" && Array.isArray(input.todos)) {
    return (
      <ul className="grid gap-0.5 text-xs">
        {input.todos.map((t, i) => {
          const todo = asInput(t);
          const done = todo.status === "completed";
          return (
            <li key={i} className={cn("flex gap-2", done && "text-muted-foreground line-through")}>
              <span className="font-mono">{done ? "✓" : todo.status === "in_progress" ? "▸" : "○"}</span>
              {String(todo.content ?? "")}
            </li>
          );
        })}
      </ul>
    );
  }
  if (name === "Agent" || name === "Task") {
    return typeof input.prompt === "string" ? (
      <p className="line-clamp-4 text-xs whitespace-pre-wrap text-muted-foreground">{input.prompt}</p>
    ) : null;
  }
  if (Object.keys(input).length === 0) return null;
  return <Output text={JSON.stringify(input, null, 2)} />;
}

function Output({ text, error }: { text: string; error?: boolean }) {
  if (!text) return null;
  return (
    <pre
      className={cn(
        "max-h-72 overflow-auto rounded-md border bg-terminal px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words",
        error && "border-destructive/40 text-destructive",
      )}
    >
      {text}
    </pre>
  );
}

function RequestLine({ event: e }: { event: Ev<"request"> }) {
  const allowed = e.decision === "allow" || e.decision === "allowSession";
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {allowed ? <CheckIcon className="size-3.5" /> : <XIcon className="size-3.5 text-destructive" />}
      {allowed ? "Allowed" : "Denied"} {toolLabel(e.toolName)}
      {e.text && <span>: {e.text}</span>}
    </div>
  );
}

function TurnEnd({ event: e, onCompact }: { event: Ev<"turn">; onCompact?: () => void }) {
  if (e.status === "error") {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive max-sm:flex-wrap">
        <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 whitespace-pre-wrap">{e.text || "The turn failed."}</span>
        {e.kind === "contextFull" && onCompact && (
          <Button size="sm" variant="secondary" className="-my-1 shrink-0" onClick={onCompact}>
            <Minimize2Icon />
            Compact conversation
          </Button>
        )}
      </div>
    );
  }
  const meta = [
    e.status === "interrupted" ? "Interrupted" : null,
    e.durationMs ? formatDuration(e.durationMs) : null,
    e.costUsd ? `$${e.costUsd.toFixed(e.costUsd < 0.1 ? 3 : 2)}` : null,
  ].filter(Boolean);
  if (meta.length === 0) return null;
  return (
    <div className={cn("text-xs text-muted-foreground/70", e.status === "interrupted" && "text-warn")}>
      {meta.join(" · ")}
    </div>
  );
}

function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
