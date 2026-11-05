// The assistant's UI, the same conversation on every device.
// Desktop: a feed on the right of the page, over it, showing the newest few
// messages and fading out going up; it expands while you hover over it (or
// focus it), and can be hidden. Cards the assistant puts up sit below it,
// and the mic is in the corner. Phones: the mic, the newest reply in a
// bubble above it, and a full-screen layer for the conversation and for
// talking; cards take the whole screen.

import type { Message } from "@mariozechner/pi-ai";
import type { AssistantApproval, AssistantEntry } from "@everywhere/protocol";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
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
import { messageText, spokenPart } from "@/lib/assistant/messages";
import { assistantSync, useAssistantSync } from "@/lib/assistant/sync";
import { useVoice, voice } from "@/lib/assistant/voice";
import { cn } from "@/lib/utils";
import { CardStack, useScreenCards } from "./cards";
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
        active={v.state === "listening" || v.state === "speaking"}
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

/** While talking: what it heard, what it's doing, and what it's asking; after, why it stopped. */
function VoiceBar({ className }: { className?: string }) {
  const v = useVoice();
  const sync = useAssistantSync();
  const { error, dismiss } = useVoiceError();
  if (v.state === "off" && !error) return null;
  const live = sync.live;
  const approval = live?.approvals[0];
  const line = error
    ? error
    : v.heard
      ? v.heard
      : live?.activity
        ? `${live.activity}…`
        : v.state === "speaking"
          ? "Speaking…"
          : sync.runner
            ? "Thinking…"
            : "Listening…";
  return (
    <div className={cn("pointer-events-auto rounded-xl border border-border bg-background/90 p-3 text-sm shadow-xl backdrop-blur-md", className)}>
      {approval && !error ? (
        <ApprovalCard approval={approval} compact />
      ) : (
        <div className="flex items-start gap-2">
          {!error && <VoiceBars active={v.state === "listening" || v.state === "speaking"} className="mt-0.5 h-4 w-12 shrink-0" />}
          <p className={cn("line-clamp-3 flex-1", v.heard ? "text-foreground" : "text-muted-foreground", error && "text-destructive")}>
            {line}
          </p>
          {error && (
            <Button variant="ghost" size="icon-sm" onClick={dismiss} aria-label="Dismiss the voice message">
              <XIcon />
            </Button>
          )}
        </div>
      )}
      {v.notice && <p className="mt-1.5 text-xs text-muted-foreground">{v.notice}</p>}
    </div>
  );
}

function ApprovalCard({ approval, compact }: { approval: AssistantApproval; compact?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium">{approval.title}?</p>
      {approval.detail && (
        <p
          className={cn(
            "whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-[13px] text-muted-foreground",
            compact ? "line-clamp-6" : "max-h-72 overflow-y-auto",
          )}
        >
          {approval.detail}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => assistantRunner.answer(approval.id, true)}>
          Allow
        </Button>
        <Button size="sm" variant="outline" onClick={() => assistantRunner.answer(approval.id, false)}>
          Deny
        </Button>
        {compact && <span className="self-center text-xs text-muted-foreground">or say yes / no</span>}
      </div>
    </div>
  );
}

/** What the feed lists: prompts, replies, thread updates, summaries; no tool calls. */
type FeedItem =
  | { key: string; kind: "user"; text: string }
  | { key: string; kind: "assistant"; text: string; error?: string }
  | { key: string; kind: "update"; text: string }
  | { key: string; kind: "summary"; text: string };

function feedItems(entries: AssistantEntry[]): FeedItem[] {
  const out: FeedItem[] = [];
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
      if (text || error) out.push({ key: `${e.seq}`, kind: "assistant", text, error });
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
        </div>
      );
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

/** The turn in progress: the reply streaming, what it's doing, approvals waiting. */
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
      {live?.activity && (
        <p className="pointer-events-auto flex items-center gap-1.5 self-start rounded-full border border-border bg-background/80 px-3 py-1 text-xs text-muted-foreground backdrop-blur-md">
          <LoaderCircleIcon className="size-3 animate-spin" />
          {live.activity}…
        </p>
      )}
      {live?.approvals.map((a) => (
        <div key={a.id} className="pointer-events-auto self-stretch rounded-2xl border border-primary/40 bg-background/90 p-3 shadow-lg backdrop-blur-md">
          <ApprovalCard approval={a} />
        </div>
      ))}
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
  }, [expanded, items.length, sync.live?.text, sync.live?.approvals.length]);

  const shown = expanded ? items : items.slice(-REST_ITEMS);
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
                  title="The mic and on-screen cards stay. Ctrl+Shift+. brings it back."
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
        <CardStack className="pointer-events-auto w-[22rem] shrink-0" />
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
  const { cards } = useScreenCards();
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
        <div className="pointer-events-none fixed right-4 bottom-24 z-40 flex flex-col items-end gap-4">
          {toast && (
            <button
              type="button"
              onClick={() => {
                setToast(null);
                setOpen(true);
              }}
              onTouchStart={(e) => (e.currentTarget.dataset.y = String(e.touches[0]?.clientY ?? 0))}
              onTouchMove={(e) => {
                if (Number(e.currentTarget.dataset.y) - (e.touches[0]?.clientY ?? 0) > 40) {
                  setToast(null);
                  setOpen(true);
                }
              }}
              className="pointer-events-auto max-w-[min(20rem,calc(100vw-2rem))] rounded-2xl rounded-br-md border border-border bg-background/90 px-3 py-2 text-left text-sm shadow-xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none"
            >
              <span className="line-clamp-4">{toast.text}</span>
              <span className="mt-1 block text-xs text-muted-foreground">Tap or swipe up for the conversation</span>
            </button>
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
          <MicButton />
        </div>
      )}
      {/* A normal card at the top; only the voice screen gives cards the whole screen. */}
      {cards.length > 0 && !layer && <PhoneCards mode="float" />}
    </>
  );
}

/**
 * The card on a phone. voice: the voice screen's, taking the space it has.
 * float: over the page at the top, its own size. chat: above the message box.
 */
function PhoneCards({ mode }: { mode: "voice" | "float" | "chat" }) {
  if (mode === "voice") {
    return (
      <div className="flex min-h-0 flex-1 flex-col px-3">
        <CardStack max={1} fill className="min-h-0 flex-1" />
      </div>
    );
  }
  return (
    <div
      className={cn(
        "pointer-events-none z-40",
        mode === "float" ? "fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))]" : "shrink-0 px-3 pb-2",
      )}
    >
      <CardStack max={1} className="pointer-events-auto [&>section]:max-h-[45vh]" />
    </div>
  );
}

/** The full-screen conversation; when talking, the voice screen. */
function PhoneLayer({ voiceMode, onClose, onMinimize }: { voiceMode: boolean; onClose: () => void; onMinimize: () => void }) {
  const sync = useAssistantSync();
  const v = useVoice();
  const { cards } = useScreenCards();
  const items = useMemo(() => feedItems(sync.entries), [sync.entries]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, sync.live?.text, sync.live?.approvals.length]);
  const said = items.at(-1);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background/85 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] backdrop-blur-xl animate-in fade-in duration-200 motion-reduce:animate-none">
      <header className="flex shrink-0 items-center gap-2 px-3 py-2">
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
          {cards.length > 0 ? (
            <PhoneCards mode="voice" />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col justify-end gap-4 overflow-hidden px-6 pb-6">
              {said?.kind === "assistant" && <p className="line-clamp-6 text-lg text-muted-foreground">{said.text}</p>}
              <p className="text-2xl leading-snug">
                {v.heard || sync.live?.text || (sync.live?.activity ? `${sync.live.activity}…` : v.state === "speaking" ? "" : "Listening…")}
              </p>
            </div>
          )}
          <VoiceBar className="mx-3 mb-2" />
          <div className="flex shrink-0 justify-center pt-10 pb-14">
            <MicButton size="lg" />
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
          {cards.length > 0 && <PhoneCards mode="chat" />}
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
