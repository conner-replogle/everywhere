// The assistant's UI, the same conversation on every device.
// Desktop: a feed on the right of the page, over it, showing the newest few
// messages and fading out going up; it expands while you hover over it (or
// focus it), and can be hidden; the mic is in the corner. Phones: the mic,
// the newest reply in a bubble above it, a sheet for the conversation, and a
// full-screen voice screen while talking.

import type { Message } from "@mariozechner/pi-ai";
import type { AssistantEntry } from "@everywhere/protocol";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleXIcon,
  KeyboardIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  MicIcon,
  MicOffIcon,
  MoreHorizontalIcon,
  PanelRightCloseIcon,
  SendIcon,
  SquareIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Markdown } from "@/components/agent/markdown";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useFleet } from "@/components/fleet";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ASSISTANT_MODELS,
  assistantRunner,
  composePrompt,
  modelId,
  setModelId,
  useAssistantRunner,
} from "@/lib/assistant/agent";
import { setFleet } from "@/lib/assistant/fleet";
import { threadName } from "@/lib/assistant/fleet";
import { fromVoice, messageText, spokenPart } from "@/lib/assistant/messages";
import { stepDetail, stepText, turnStatus } from "@/lib/assistant/steps";
import { assistantSync, useAssistantSync } from "@/lib/assistant/sync";
import { useVoice, voice } from "@/lib/assistant/voice";
import { cn } from "@/lib/utils";
import { holdAlerts } from "@/lib/alerts";
import { VoiceInbox } from "./voice-inbox";
import { useSwipeAway } from "./swipe";
import { VoiceBars, VoiceRing } from "./visualizer";

/** The feed, at rest: this many of the newest messages. */
const REST_ITEMS = 3;
/** Hovering this long expands the feed; leaving for this long folds it back. */
const EXPAND_DELAY_MS = 150;
const COLLAPSE_DELAY_MS = 400;
/** How much room the mic takes in the corner, for the thread composer to keep clear of. */
const DOCK_INSET = "6rem";
const HIDDEN_KEY = "ew.assistant.feedHidden";

/** Keeps the assistant's view of the fleet current and starts its connection. */
function AssistantBridge() {
  const { devices, entries } = useFleet();
  const navigate = useNavigate();
  useEffect(() => {
    setFleet(entries, new Map((devices ?? []).map((d) => [d.id, d.name])));
  }, [devices, entries]);
  useEffect(() => {
    assistantSync.start();
    assistantRunner.navigate = (deviceId, threadId) =>
      void navigate({ to: "/d/$deviceId/t/$threadId", params: { deviceId, threadId } });
    return () => {
      assistantRunner.navigate = null;
    };
  }, [navigate]);
  return null;
}

const PHONE = "(max-width: 767px)";

function usePhone(): boolean {
  return useSyncExternalStore(
    (fn) => {
      const q = matchMedia(PHONE);
      q.addEventListener("change", fn);
      return () => q.removeEventListener("change", fn);
    },
    () => matchMedia(PHONE).matches,
  );
}

export function Assistant() {
  const phone = usePhone();
  return (
    <>
      <AssistantBridge />
      {phone ? <PhoneAssistant /> : <DesktopAssistant />}
    </>
  );
}

// --- shared pieces --------------------------------------------------------------

/** Why the voice stopped stays up until it's dismissed or the voice starts again. */
function useVoiceError(): { error: string | null; dismiss: () => void } {
  const v = useVoice();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const error = v.state === "off" && v.error && v.error !== dismissed ? v.error : null;
  return { error, dismiss: () => setDismissed(v.error) };
}

function MicButton({ size = "md", className }: { size?: "md" | "lg"; className?: string }) {
  const v = useVoice();
  const sync = useAssistantSync();
  const runner = useAssistantRunner();
  const working = runner.busy || !!sync.runner;
  const big = size === "lg";
  return (
    <div className={cn("relative", big && "scale-[1.6]", className)}>
      <VoiceRing
        active={v.state === "speaking" || (v.state === "listening" && !v.muted)}
        className="absolute top-1/2 left-1/2 size-32 -translate-x-1/2 -translate-y-1/2"
      />
      <button
        type="button"
        // Keep the page's text selection: it goes with the prompt.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => voice.toggle()}
        aria-label={v.state === "off" ? "Talk to the assistant" : "Stop talking"}
        className={cn(
          "pointer-events-auto relative flex size-12 items-center justify-center rounded-full shadow-xl transition-colors",
          v.state === "off" ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-destructive/90 text-white",
        )}
      >
        {v.state === "starting" ? (
          <LoaderCircleIcon className="size-5 animate-spin" />
        ) : v.state === "off" ? (
          <MicIcon className="size-5" />
        ) : (
          <MicOffIcon className="size-5" />
        )}
        {working && v.state === "off" && (
          <span className="absolute -inset-1 animate-spin rounded-full border-2 border-transparent border-t-primary" />
        )}
      </button>
    </div>
  );
}

/**
 * While talking: mutes the mic without ending the call, and unmutes it. Shows
 * what the mic is doing now: struck through and amber while muted.
 */
function MuteButton({ size = "md", className }: { size?: "md" | "lg"; className?: string }) {
  const v = useVoice();
  if (v.state === "off" || v.state === "starting") return null;
  const label = v.muted ? "Unmute the mic" : "Mute the mic";
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => voice.toggleMute()}
      aria-label={label}
      aria-pressed={v.muted}
      title={label}
      className={cn(
        "pointer-events-auto flex shrink-0 items-center justify-center rounded-full border shadow-lg backdrop-blur transition-colors",
        size === "lg" ? "size-14" : "size-10",
        v.muted
          ? "border-amber-500 bg-amber-500 text-white hover:bg-amber-500/90"
          : "border-border bg-background/90 text-foreground hover:bg-muted",
        className,
      )}
    >
      {v.muted ? <MicOffIcon className={size === "lg" ? "size-6" : "size-4"} /> : <MicIcon className={size === "lg" ? "size-6" : "size-4"} />}
    </button>
  );
}

/** While talking: what it heard and what it's doing; after, why it stopped. */
function VoiceBar({ className, statusOnly }: { className?: string; statusOnly?: boolean }) {
  const v = useVoice();
  const sync = useAssistantSync();
  const { error, dismiss } = useVoiceError();
  // Before the early return: hooks run in the same order every render.
  const { status } = useTurnStatus();
  if (v.state === "off" && !error) return null;
  const live = sync.live;
  // statusOnly: what's being said shows in the conversation instead.
  const heard = statusOnly ? "" : v.heard;
  const line = error
    ? error
    : heard
      ? heard
      : v.state === "speaking"
        ? "Speaking…"
        : v.muted
          ? "Muted. Unmute to talk."
          : (status?.label ?? (sync.runner ? "Writing…" : "Listening…"));
  return (
    <div className={cn("pointer-events-auto rounded-xl border border-border bg-background/90 p-3 text-sm shadow-xl backdrop-blur-md", className)}>
      <div className="flex items-start gap-2">
        {!error && v.muted && v.state !== "speaking" ? (
          <MicOffIcon className="mt-0.5 size-4 shrink-0 text-amber-500" />
        ) : (
          !error && <VoiceBars active={v.state === "listening" || v.state === "speaking"} className="mt-0.5 h-4 w-12 shrink-0" />
        )}
        <p
          className={cn(
            "line-clamp-3 flex-1",
            heard ? "text-foreground" : "text-muted-foreground",
            v.muted && !heard && !error && v.state !== "speaking" && "text-amber-600 dark:text-amber-400",
            error && "text-destructive",
          )}
        >
          {line}
        </p>
        {error && (
          <Button variant="ghost" size="icon-sm" onClick={dismiss} aria-label="Dismiss the voice message">
            <XIcon />
          </Button>
        )}
      </div>
      {v.notice && <p className="mt-1.5 text-xs text-muted-foreground">{v.notice}</p>}
    </div>
  );
}

/** What the feed lists: prompts, replies, thread updates, summaries; no tool calls. */
type FeedItem =
  | { key: string; kind: "user"; text: string }
  | { key: string; kind: "assistant"; text: string; error?: string; /** GPT-Live answered it, not the agent. */ voice?: boolean }
  | { key: string; kind: "update"; text: string }
  | { key: string; kind: "summary"; text: string }
  /** Something the agent did (a tool call): pending until its result is in. */
  | { key: string; kind: "step"; text: string; detail?: string; state: "pending" | "done" | "failed" };

/** Old calls that put cards on screen, which the chat doesn't show. */
const HIDDEN_TOOLS = new Set(["show_on_screen", "clear_screen"]);

function feedItems(entries: AssistantEntry[]): FeedItem[] {
  const out: FeedItem[] = [];
  // How each tool call came out.
  const results = new Map<string, boolean>();
  // A call with no result from before the newest user message was stopped.
  let lastUser = -1;
  for (const e of entries) {
    const m = e.kind === "message" ? (e.message as Message) : null;
    if (m?.role === "toolResult") results.set(m.toolCallId, !!m.isError);
    if (m?.role === "user") lastUser = e.seq;
  }
  for (const e of entries) {
    if (e.kind === "compaction") {
      out.push({ key: `c${e.seq}`, kind: "summary", text: e.summary });
      continue;
    }
    const m = e.message as Message;
    if (m.role === "user") {
      const text = messageText(m);
      if (text.startsWith("[Update]")) out.push({ key: `${e.seq}`, kind: "update", text: text.slice(9).split("\n")[0] ?? "" });
      else out.push({ key: `${e.seq}`, kind: "user", text: spokenPart(text) });
    } else if (m.role === "assistant") {
      const text = messageText(m).trim();
      const error = m.stopReason === "error" ? m.errorMessage : undefined;
      if (text || error) out.push({ key: `${e.seq}`, kind: "assistant", text, error, voice: fromVoice(m) });
      for (const b of m.content) {
        if (b.type !== "toolCall" || HIDDEN_TOOLS.has(b.name)) continue;
        const args = (b.arguments ?? {}) as Record<string, unknown>;
        const failed = results.get(b.id);
        out.push({
          key: `${e.seq}:${b.id}`,
          kind: "step",
          text: stepText(b.name, args, threadName),
          detail: stepDetail(b.name, args),
          state: failed === undefined ? (e.seq < lastUser ? "failed" : "pending") : failed ? "failed" : "done",
        });
      }
    }
  }
  return out;
}

function Bubble({ item }: { item: FeedItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="pointer-events-auto ml-10 self-end rounded-2xl rounded-br-md border border-primary/25 bg-primary/15 px-3 py-2 whitespace-pre-wrap shadow-lg backdrop-blur-md">
          {item.text}
        </div>
      );
    case "assistant":
      return (
        <div className="pointer-events-auto mr-6 self-start rounded-2xl rounded-bl-md border border-border bg-background/85 px-3 py-2 shadow-lg backdrop-blur-md">
          {item.text && <Markdown text={item.text} />}
          {item.error && <p className="text-xs text-destructive">{item.error}</p>}
          {item.voice && <p className="mt-1 text-[11px] text-muted-foreground">Answered by GPT-Live</p>}
        </div>
      );
    case "step":
      return <StepLine item={item} />;
    case "update":
      return (
        <p className="pointer-events-auto self-start rounded-full border border-border bg-background/80 px-3 py-1 text-xs text-muted-foreground backdrop-blur-md">
          {item.text}
        </p>
      );
    case "summary":
      return (
        <details className="pointer-events-auto self-stretch rounded-xl border border-dashed border-border bg-background/80 px-3 py-2 text-xs text-muted-foreground backdrop-blur-md">
          <summary className="cursor-pointer">Earlier conversation summarized</summary>
          <p className="mt-2 whitespace-pre-wrap">{item.text}</p>
        </details>
      );
  }
}

function StepLine({ item }: { item: FeedItem & { kind: "step" } }) {
  const Icon = item.state === "pending" ? LoaderCircleIcon : item.state === "failed" ? CircleXIcon : CheckIcon;
  const line = (
    <span className="inline-flex items-center gap-1.5">
      <Icon
        className={cn(
          "size-3 shrink-0",
          item.state === "pending" && "animate-spin",
          item.state === "failed" ? "text-destructive" : "text-muted-foreground",
        )}
      />
      {item.text}
      {item.state === "failed" && " (failed)"}
    </span>
  );
  return (
    <div className="pointer-events-auto self-start px-1 text-xs text-muted-foreground">
      {item.detail ? (
        <details>
          <summary className="cursor-pointer list-none">{line}</summary>
          <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-background/85 p-2 text-foreground/90">
            {item.detail}
          </p>
        </details>
      ) : (
        line
      )}
    </div>
  );
}

/** The newest n prompts and replies, with the steps between them. */
function restingItems(items: FeedItem[], n: number): FeedItem[] {
  let seen = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind !== "step" && ++seen === n) return items.slice(i);
  }
  return items;
}

/** Seconds since key last changed, ticking while active. */
function useSeconds(key: string, active: boolean): number {
  const [since, setSince] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setSince(Date.now());
    setNow(Date.now());
  }, [key]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** Where the running turn is (waiting on the model, thinking, a tool), with how long it's been. */
function useTurnStatus() {
  const sync = useAssistantSync();
  const runner = useAssistantRunner();
  const live = sync.live;
  const running = runner.busy || !!sync.runner;
  const seconds = useSeconds(`${live?.phase}|${live?.activity}`, running);
  return { status: turnStatus(live, running, seconds), thinking: live?.phase === "thinking" ? live.thinking : undefined };
}

function TurnStatus() {
  const { status, thinking } = useTurnStatus();
  if (!status) return null;
  return (
    <div className="pointer-events-auto flex max-w-full flex-col gap-1 self-start">
      <p
        className={cn(
          "flex items-center gap-1.5 self-start rounded-full border bg-background/80 px-3 py-1 text-xs backdrop-blur-md",
          status.slow ? "border-warn/50 text-warn" : "border-border text-muted-foreground",
        )}
      >
        <LoaderCircleIcon className="size-3 animate-spin" />
        {status.label}
      </p>
      {thinking && <p className="line-clamp-2 px-3 text-xs italic text-muted-foreground/80">{thinking}</p>}
    </div>
  );
}

/** The turn in progress: the reply streaming and where it is. */
function LiveItems() {
  const sync = useAssistantSync();
  const runner = useAssistantRunner();
  const live = sync.live;
  return (
    <>
      {live?.text && (
        <div className="pointer-events-auto mr-6 self-start rounded-2xl rounded-bl-md border border-border bg-background/85 px-3 py-2 shadow-lg backdrop-blur-md">
          <Markdown text={live.text} />
        </div>
      )}
      <TurnStatus />
      {runner.error && (
        <p className="pointer-events-auto self-start rounded-xl border border-destructive/40 bg-background/90 px-3 py-2 text-xs text-destructive backdrop-blur-md">
          {runner.error}
        </p>
      )}
    </>
  );
}

function Composer({ autoFocus, onDone, className }: { autoFocus?: boolean; onDone?: () => void; className?: string }) {
  const sync = useAssistantSync();
  const runner = useAssistantRunner();
  const [draft, setDraft] = useState("");
  const busy = runner.busy || !!sync.runner;
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void assistantRunner.prompt(composePrompt(text));
  };
  return (
    <div className={cn("pointer-events-auto flex items-end gap-1.5 rounded-2xl border border-border bg-background/90 p-1.5 shadow-xl backdrop-blur-md", className)}>
      <textarea
        value={draft}
        autoFocus={autoFocus}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          } else if (e.key === "Escape") {
            (e.target as HTMLTextAreaElement).blur();
            onDone?.();
          }
        }}
        rows={1}
        placeholder="Ask about anything, on any device…"
        className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none field-sizing-content"
      />
      {busy && !draft.trim() ? (
        <Button variant="outline" size="icon" className="size-8 rounded-full" onClick={() => assistantRunner.stop()} aria-label="Stop">
          <SquareIcon className="size-3.5" />
        </Button>
      ) : (
        <Button size="icon" className="size-8 rounded-full" onClick={send} disabled={!draft.trim()} aria-label="Send">
          <SendIcon className="size-4" />
        </Button>
      )}
    </div>
  );
}

/** Model, clearing, and (on desktop) hiding the feed. */
function FeedMenu({ onHide }: { onHide?: () => void }) {
  const sync = useAssistantSync();
  const runner = useAssistantRunner();
  const [model, setModel] = useState(modelId);
  const [confirmClear, setConfirmClear] = useState(false);
  const busy = runner.busy || !!sync.runner;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="pointer-events-auto" aria-label="Assistant options">
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Model</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={model}
            onValueChange={(id) => {
              setModelId(id);
              setModel(id);
            }}
          >
            {ASSISTANT_MODELS.map((m) => (
              <DropdownMenuRadioItem key={m.id} value={m.id}>
                {m.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={busy || sync.entries.length === 0} onSelect={() => setConfirmClear(true)}>
            <Trash2Icon /> Clear the conversation
          </DropdownMenuItem>
          {onHide && (
            <DropdownMenuItem onSelect={onHide}>
              <PanelRightCloseIcon /> Hide chat
              <span className="ml-auto text-xs text-muted-foreground">Ctrl+Shift+.</span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear the conversation?"
        description={
          <p>
            This deletes the assistant's whole conversation, earlier summaries included, on every device. The next thing
            you say starts fresh. It can't be undone.
          </p>
        }
        confirmLabel="Clear"
        onConfirm={() => assistantSync.clear()}
      />
    </>
  );
}

// --- desktop ----------------------------------------------------------------------

function useFeedHidden(): [boolean, (h: boolean) => void] {
  const [hidden, setHidden] = useState(() => localStorage.getItem(HIDDEN_KEY) === "1");
  const set = useCallback((h: boolean) => {
    setHidden(h);
    if (h) localStorage.setItem(HIDDEN_KEY, "1");
    else localStorage.removeItem(HIDDEN_KEY);
  }, []);
  return [hidden, set];
}

/** Typing in something of the page's own (a thread's composer), not ours. */
function typingElsewhere(inside: HTMLElement | null): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (!a || inside?.contains(a)) return false;
  return /^(INPUT|TEXTAREA)$/.test(a.tagName) || a.isContentEditable;
}

function DesktopAssistant() {
  const sync = useAssistantSync();
  const runner = useAssistantRunner();
  const v = useVoice();
  const [hidden, setHidden] = useFeedHidden();
  const [expanded, setExpanded] = useState(false);
  const [typing, setTyping] = useState(false);
  const feed = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const items = useMemo(() => feedItems(sync.entries), [sync.entries]);

  // The mic's corner, for the thread composer to keep clear of.
  useEffect(() => {
    document.documentElement.style.setProperty("--assistant-dock", DOCK_INSET);
    return () => void document.documentElement.style.removeProperty("--assistant-dock");
  }, []);

  // Someone sees the conversation while the feed shows or the voice is on.
  useEffect(() => {
    assistantRunner.attended = !hidden || v.state !== "off";
    if (!hidden) assistantRunner.markRead();
  }, [hidden, v.state, items.length]);

  // Ctrl+Shift+. hides and shows it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === ">" || e.key === "." || e.code === "Period")) {
        e.preventDefault();
        setHidden(!hidden);
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden, setHidden]);

  const later = (fn: () => void, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  };
  const expand = () => {
    if (typingElsewhere(feed.current)) return;
    later(() => setExpanded(true), EXPAND_DELAY_MS);
  };
  const collapse = () =>
    later(() => {
      if (feed.current?.contains(document.activeElement)) return;
      setExpanded(false);
      setTyping(false);
    }, COLLAPSE_DELAY_MS);

  // Expanded: show the newest at the bottom as it comes.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current;
    if (el && (!expanded || el.scrollHeight - el.scrollTop - el.clientHeight < 120)) el.scrollTop = el.scrollHeight;
  }, [expanded, items.length, sync.live?.text]);

  const shown = expanded ? items : restingItems(items, REST_ITEMS);
  const open = expanded || typing;
  return (
    <>
      <div className="pointer-events-none fixed inset-y-0 right-0 z-40 flex flex-col items-end justify-end gap-3 pt-14 pr-6 pb-6">
        {!hidden && (
          <div
            ref={feed}
            onPointerEnter={expand}
            onPointerLeave={collapse}
            onWheel={() => !open && setExpanded(true)}
            onFocus={() => {
              clearTimeout(timer.current);
              setExpanded(true);
            }}
            onBlur={(e) => {
              if (!feed.current?.contains(e.relatedTarget as Node)) collapse();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setExpanded(false);
                setTyping(false);
                (document.activeElement as HTMLElement | null)?.blur();
              }
            }}
            className={cn(
              "flex min-h-0 flex-col transition-[width,max-height,background-color,border-color] duration-300 ease-out motion-reduce:transition-none",
              open
                ? "pointer-events-auto max-h-full w-[min(46rem,44vw)] rounded-2xl border border-border bg-background/70 p-2 shadow-2xl backdrop-blur-xl"
                : "max-h-[22rem] w-[22rem] border border-transparent",
            )}
          >
            {open && (
              <div className="flex shrink-0 items-center gap-2 px-1 pb-1">
                <span className="flex-1 text-xs font-medium text-muted-foreground">Assistant</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-full text-xs"
                  onClick={() => {
                    setHidden(true);
                    setExpanded(false);
                  }}
                  title="The mic stays. Ctrl+Shift+. brings it back."
                >
                  <PanelRightCloseIcon /> Hide chat
                </Button>
                <FeedMenu onHide={() => setHidden(true)} />
              </div>
            )}
            <div
              ref={list}
              className={cn(
                "flex min-h-0 flex-col gap-2 text-sm",
                open
                  ? "overflow-y-auto overscroll-contain px-1 [mask-image:linear-gradient(to_bottom,transparent,black_2rem)]"
                  : // At rest the newest stay in view: what doesn't fit goes off the top.
                    "justify-end overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_45%)]",
              )}
            >
              {open && sync.hasEarlier && (
                <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => assistantSync.loadEarlier()}>
                  Load earlier
                </button>
              )}
              {open && sync.synced && items.length === 0 && (
                <p className="px-1 text-muted-foreground">Ask about any of your threads and projects, or tell it what to get done.</p>
              )}
              {shown.map((it) => (
                <Bubble key={it.key} item={it} />
              ))}
              <LiveItems />
            </div>
            {open && <Composer autoFocus={typing} onDone={() => setTyping(false)} className="mt-2 shrink-0" />}
          </div>
        )}
        <VoiceBar className="w-[22rem] shrink-0" />
        <div className="flex shrink-0 items-end gap-3">
          {!hidden && !open && (
            <Button
              variant="outline"
              size="icon"
              className="pointer-events-auto mb-1 size-9 rounded-full bg-background/90 shadow-lg backdrop-blur"
              onClick={() => {
                setTyping(true);
                setExpanded(true);
              }}
              aria-label="Type to the assistant"
              title="Type to the assistant"
            >
              <KeyboardIcon className="size-4" />
            </Button>
          )}
          <MuteButton className="mb-1" />
          <MicButton />
        </div>
      </div>
      {hidden && (
        <button
          type="button"
          onClick={() => setHidden(false)}
          className="fixed top-1/2 right-0 z-40 flex -translate-y-1/2 flex-col items-center gap-1.5 rounded-l-xl border border-r-0 border-border bg-background/90 px-1.5 py-3 text-xs text-muted-foreground shadow-lg backdrop-blur hover:text-foreground"
          title="Show the chat (Ctrl+Shift+.)"
          aria-label="Show the chat"
        >
          <MessageSquareTextIcon className="size-4" />
          <span className="[writing-mode:vertical-rl]">Chat</span>
          {runner.unread > 0 && <span className="size-2 rounded-full bg-primary" aria-label={`${runner.unread} unread`} />}
        </button>
      )}
    </>
  );
}

// --- phones -----------------------------------------------------------------------

/** How long the newest reply stays in its bubble above the mic. */
const TOAST_MS = 6000;

function PhoneAssistant() {
  const sync = useAssistantSync();
  const runner = useAssistantRunner();
  const v = useVoice();
  const [open, setOpen] = useState(false);
  // Talking opens the voice screen; minimized, it's just the mic (still listening).
  const [minimized, setMinimized] = useState(false);
  const items = useMemo(() => feedItems(sync.entries), [sync.entries]);
  const talking = v.state !== "off";
  const layer = open || (talking && !minimized);
  useEffect(() => {
    if (!talking) setMinimized(false);
  }, [talking]);

  useEffect(() => {
    assistantRunner.attended = layer;
    if (layer) assistantRunner.markRead();
  }, [layer, items.length]);

  // The newest reply, for a moment, while the layer is closed.
  const newest = items.at(-1);
  const [toast, setToast] = useState<FeedItem | null>(null);
  const seen = useRef(newest?.key);
  useEffect(() => {
    if (!newest || newest.key === seen.current) return;
    seen.current = newest.key;
    if (layer || newest.kind !== "assistant") return;
    setToast(newest);
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [newest, layer]);

  return (
    <>
      {layer ? (
        <PhoneLayer
          voiceMode={talking}
          onClose={() => (talking ? voice.stop() : setOpen(false))}
          onMinimize={() => {
            setOpen(false);
            if (talking) setMinimized(true);
          }}
        />
      ) : (
        // Above the thread composer when there is one (it's full width on a phone).
        <div className="pointer-events-none fixed right-4 bottom-[max(6rem,calc(var(--composer-height,0px)_+_1.75rem))] z-40 flex flex-col items-end gap-4">
          {toast && (
            <ReplyToast
              text={toast.text}
              onOpen={() => {
                setToast(null);
                setOpen(true);
              }}
              onDismiss={() => setToast(null)}
            />
          )}
          <Button
            variant="outline"
            size="icon"
            className="pointer-events-auto relative size-10 rounded-full bg-background/90 shadow-lg backdrop-blur"
            onClick={() => {
              setOpen(true);
              setMinimized(false);
            }}
            aria-label="Open the conversation"
          >
            <MessageSquareTextIcon className="size-4" />
            {runner.unread > 0 && <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-primary ring-2 ring-background" />}
          </Button>
          <MuteButton />
          <MicButton />
        </div>
      )}
    </>
  );
}

/**
 * The conversation on the voice screen: the newest couple of lines, fading
 * out upward, with what you're saying as it's heard. Tap to open it all and
 * scroll back; tap the header to fold it again.
 */
function VoiceConversation({ items }: { items: FeedItem[] }) {
  const sync = useAssistantSync();
  const v = useVoice();
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, items.length, sync.live?.text, v.heard]);
  const shown = open ? items : restingItems(items, 2);
  return (
    <section aria-label="The conversation" className="shrink-0 px-3 pb-2">
      <div className="rounded-2xl border border-border bg-background/60 backdrop-blur-md">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex w-full items-center gap-1 px-3 pt-2 pb-1 text-xs text-muted-foreground"
        >
          <span className="flex-1 text-left">Conversation</span>
          {open ? <ChevronDownIcon className="size-4" /> : <ChevronUpIcon className="size-4" />}
        </button>
        <div
          ref={list}
          onClick={() => !open && setOpen(true)}
          className={cn(
            "flex flex-col gap-2 px-3 pb-3 text-sm",
            open
              ? "max-h-[55dvh] overflow-y-auto overscroll-contain"
              : "max-h-32 overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_2.5rem)]",
          )}
        >
          {open && sync.hasEarlier && (
            <button type="button" className="text-xs text-muted-foreground" onClick={() => assistantSync.loadEarlier()}>
              Load earlier
            </button>
          )}
          {shown.map((it) => (
            <Bubble key={it.key} item={it} />
          ))}
          {v.heard && (
            <div className="ml-10 self-end rounded-2xl rounded-br-md border border-dashed border-primary/30 bg-primary/10 px-3 py-2 whitespace-pre-wrap text-foreground/80">
              {v.heard}
            </div>
          )}
          <LiveItems />
        </div>
      </div>
    </section>
  );
}

/** The newest reply for a moment: tap for the conversation, swipe it away. */
function ReplyToast({ text, onOpen, onDismiss }: { text: string; onOpen: () => void; onDismiss: () => void }) {
  const swipe = useSwipeAway(onDismiss, ["left", "right", "up", "down"]);
  return (
    <button
      type="button"
      {...swipe.handlers}
      style={swipe.style}
      onClick={() => {
        if (!swipe.swiped()) onOpen();
      }}
      className="pointer-events-auto max-w-[min(20rem,calc(100vw-2rem))] touch-none rounded-2xl rounded-br-md border border-border bg-background/90 px-3 py-2 text-left text-sm shadow-xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none"
    >
      <span className="line-clamp-4">{text}</span>
      <span className="mt-1 block text-xs text-muted-foreground">Tap for the conversation, swipe to dismiss</span>
    </button>
  );
}

/**
 * The conversation, as a sheet from the bottom with the page still showing
 * above it (swipe its top down to close); when talking, the full-screen voice screen.
 */
function PhoneLayer({ voiceMode, onClose, onMinimize }: { voiceMode: boolean; onClose: () => void; onMinimize: () => void }) {
  const sync = useAssistantSync();
  const v = useVoice();
  const items = useMemo(() => feedItems(sync.entries), [sync.entries]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, sync.live?.text]);
  const swipe = useSwipeAway(onMinimize, ["down"]);
  // The voice screen shows the thread alerts itself, as an inbox.
  useEffect(() => {
    holdAlerts(voiceMode);
    return () => holdAlerts(false);
  }, [voiceMode]);
  return (
    <div
      style={voiceMode ? undefined : swipe.style}
      className={cn(
        "fixed z-50 flex flex-col bg-background/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl motion-reduce:animate-none",
        voiceMode
          ? "inset-0 pt-[env(safe-area-inset-top)] animate-in fade-in duration-200"
          : "inset-x-0 bottom-0 h-[78dvh] rounded-t-2xl border-t border-border shadow-2xl animate-in slide-in-from-bottom-8 fade-in duration-200",
      )}
    >
      <header {...(voiceMode ? {} : swipe.handlers)} className={cn("relative flex shrink-0 items-center gap-2 px-3 py-2", !voiceMode && "touch-none pt-4")}>
        {!voiceMode && <span aria-hidden className="absolute top-1.5 left-1/2 h-1 w-10 -translate-x-1/2 rounded-full bg-muted-foreground/40" />}
        <Button variant="ghost" size="icon" onClick={onMinimize} aria-label="Minimize">
          <ChevronDownIcon className="size-5" />
        </Button>
        <h2 className="flex-1 text-sm font-semibold">{voiceMode ? "Talking" : "Assistant"}</h2>
        <FeedMenu />
        <Button variant="ghost" size="icon" onClick={onClose} aria-label={voiceMode ? "Stop talking" : "Close"}>
          <XIcon className="size-5" />
        </Button>
      </header>
      {voiceMode ? (
        <>
          {/* Top to bottom: what's happening in the threads, a few lines of the conversation (tap for
              all of it), the status, the mic. */}
          <VoiceInbox onOpen={onMinimize} className="max-h-[30dvh] shrink-0 overflow-y-auto overscroll-contain px-3 pb-2" />
          <div className="min-h-0 flex-1" />
          <VoiceConversation items={items} />
          <VoiceBar statusOnly className="mx-3 mb-2" />
          {/* The mic in the middle; mute on its left, balanced by a spacer on its right. */}
          <div className="flex shrink-0 items-center justify-center gap-12 pt-4 pb-10">
            <MuteButton size="lg" />
            <MicButton size="lg" />
            <span aria-hidden className="size-14 shrink-0" />
          </div>
        </>
      ) : (
        <>
          <div ref={list} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-3 pb-3 text-sm">
            {sync.hasEarlier && (
              <button type="button" className="text-xs text-muted-foreground" onClick={() => assistantSync.loadEarlier()}>
                Load earlier
              </button>
            )}
            {sync.synced && items.length === 0 && (
              <p className="text-muted-foreground">Ask about any of your threads and projects, or tell it what to get done.</p>
            )}
            {items.map((it) => (
              <Bubble key={it.key} item={it} />
            ))}
            <LiveItems />
          </div>
          {/* The mic above, so the message box has the full width. */}
          <div className="flex shrink-0 flex-col items-end gap-3 px-3 pb-3">
            <MicButton />
            <Composer className="w-full" />
          </div>
        </>
      )}
    </div>
  );
}
