// The assistant's UI: one button, on every page, that starts a voice
// conversation; a bar beside it while talking; and a panel with the whole
// conversation, which is the same on every device.

import type { Message } from "@mariozechner/pi-ai";
import type { AssistantApproval, AssistantEntry } from "@everywhere/protocol";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon, MessageSquareTextIcon, MicIcon, MicOffIcon, SendIcon, SquareIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "@/components/agent/markdown";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useFleet } from "@/components/fleet";
import { Button } from "@/components/ui/button";
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

export function Assistant() {
  const [open, setOpen] = useState(false);
  const v = useVoice();
  const sync = useAssistantSync();
  const runner = useAssistantRunner();
  const working = runner.busy || !!sync.runner;

  useEffect(() => {
    assistantRunner.attended = open || v.state !== "off";
    if (open) assistantRunner.markRead();
  }, [open, v.state]);

  return (
    <>
      <AssistantBridge />
      {open && <AssistantPanel onClose={() => setOpen(false)} />}
      {/* The panel has its own mic. */}
      {!open && (
        <div className="pointer-events-none fixed right-4 bottom-24 z-40 flex items-end gap-2 md:bottom-20">
          {v.state !== "off" && <VoiceBar />}
          <div className="pointer-events-auto flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label="Open the assistant's conversation"
              className="relative flex size-9 items-center justify-center rounded-full border border-border bg-background/90 text-muted-foreground shadow-lg backdrop-blur hover:text-foreground"
            >
              <MessageSquareTextIcon className="size-4" />
              {runner.unread > 0 && (
                <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-primary ring-2 ring-background" />
              )}
            </button>
            <button
              type="button"
              // Keep the page's text selection: it goes with the prompt.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => voice.toggle()}
              aria-label={v.state === "off" ? "Talk to the assistant" : "Stop talking"}
              className={cn(
                "relative flex size-12 items-center justify-center rounded-full shadow-xl transition-colors",
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
              {v.state === "listening" && (
                <span className="absolute inset-0 animate-ping rounded-full bg-destructive/40 [animation-duration:2s]" />
              )}
              {working && v.state === "off" && (
                <span className="absolute -inset-1 animate-spin rounded-full border-2 border-transparent border-t-primary" />
              )}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** While talking: what it heard, what it's doing, and what it's asking. */
function VoiceBar() {
  const v = useVoice();
  const sync = useAssistantSync();
  const live = sync.live;
  const approval = live?.approvals[0];
  const line = v.error
    ? v.error
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
    <div className="pointer-events-auto mb-1 w-[min(22rem,calc(100vw-6rem))] rounded-xl border border-border bg-background/95 p-3 text-sm shadow-xl backdrop-blur">
      {approval ? (
        <ApprovalCard approval={approval} compact />
      ) : (
        <p className={cn("line-clamp-3", v.heard ? "text-foreground" : "text-muted-foreground", v.error && "text-destructive")}>
          {line}
        </p>
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

function AssistantPanel({ onClose }: { onClose: () => void }) {
  const sync = useAssistantSync();
  const runner = useAssistantRunner();
  const v = useVoice();
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState(modelId);
  const [confirmClear, setConfirmClear] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const live = sync.live;
  const busy = runner.busy || !!sync.runner;

  // Stay at the bottom as the conversation grows.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sync.entries.length, live?.text, live?.approvals.length]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void assistantRunner.prompt(composePrompt(text));
  };

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-[min(28rem,100vw)] flex-col border-l border-border bg-background shadow-2xl">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="flex-1 text-sm font-semibold">Assistant</h2>
        <select
          value={model}
          onChange={(e) => {
            setModelId(e.target.value);
            setModel(e.target.value);
          }}
          className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs text-muted-foreground"
          aria-label="Model"
        >
          {ASSISTANT_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setConfirmClear(true)}
          disabled={busy || sync.entries.length === 0}
          aria-label="Clear the conversation"
          title={busy ? "Stop the turn to clear" : "Clear the conversation"}
        >
          <Trash2Icon className="size-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
          <XIcon className="size-4" />
        </Button>
      </header>
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
      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
        {sync.hasEarlier && (
          <button type="button" className="w-full text-xs text-muted-foreground hover:text-foreground" onClick={() => assistantSync.loadEarlier()}>
            Load earlier
          </button>
        )}
        {!sync.synced && sync.entries.length === 0 && <p className="text-muted-foreground">Loading the conversation…</p>}
        {sync.synced && sync.entries.length === 0 && (
          <p className="text-muted-foreground">
            Ask about any of your threads and projects, or tell it what to get done. Tap the mic to talk.
          </p>
        )}
        <Entries entries={sync.entries} />
        {live?.text && <Markdown text={live.text} />}
        {live?.activity && <p className="text-xs text-muted-foreground">{live.activity}…</p>}
        {live?.approvals.map((a) => (
          <div key={a.id} className="rounded-lg border border-border p-3">
            <ApprovalCard approval={a} />
          </div>
        ))}
        {runner.error && <p className="text-destructive">{runner.error}</p>}
      </div>
      <footer className="border-t border-border p-2">
        {v.state !== "off" && (
          <p className="truncate px-1 pb-1 text-xs text-muted-foreground">{v.heard || (v.state === "speaking" ? "Speaking…" : "Listening…")}</p>
        )}
        <div className="flex items-end gap-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder="Ask about anything, on any device…"
            className="max-h-40 min-h-9 flex-1 resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60 field-sizing-content"
          />
          <Button
            variant={v.state === "off" ? "outline" : "destructive"}
            size="icon"
            className="size-9"
            onClick={() => voice.toggle()}
            aria-label={v.state === "off" ? "Talk" : "Stop talking"}
          >
            {v.state === "off" ? <MicIcon className="size-4" /> : <MicOffIcon className="size-4" />}
          </Button>
          {busy && !draft.trim() ? (
            <Button variant="outline" size="icon" className="size-9" onClick={() => assistantRunner.stop()} aria-label="Stop">
              <SquareIcon className="size-3.5" />
            </Button>
          ) : (
            <Button size="icon" className="size-9" onClick={send} disabled={!draft.trim()} aria-label="Send">
              <SendIcon className="size-4" />
            </Button>
          )}
        </div>
      </footer>
    </aside>
  );
}

function Entries({ entries }: { entries: AssistantEntry[] }) {
  const items = useMemo(() => entries.map((e) => <Entry key={e.seq} entry={e} />), [entries]);
  return <>{items}</>;
}

function Entry({ entry }: { entry: AssistantEntry }) {
  if (entry.kind === "compaction") {
    return (
      <details className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer">Earlier conversation summarized</summary>
        <p className="mt-2 whitespace-pre-wrap">{entry.summary}</p>
      </details>
    );
  }
  const m = entry.message as Message;
  if (m.role === "user") {
    const text = messageText(m);
    if (text.startsWith("[Update]")) {
      return <p className="border-l-2 border-primary/50 pl-2 text-xs text-muted-foreground">{text.slice(9).split("\n")[0]}</p>;
    }
    return (
      <div className="ml-8 rounded-lg bg-muted px-3 py-2 whitespace-pre-wrap">{spokenPart(text)}</div>
    );
  }
  if (m.role === "assistant") {
    const text = messageText(m);
    const calls = m.content.filter((b) => b.type === "toolCall");
    return (
      <div className="space-y-1">
        {text.trim() && <Markdown text={text} />}
        {calls.map((c) =>
          c.type === "toolCall" ? (
            <p key={c.id} className="text-xs text-muted-foreground">
              · {c.name.replace(/_/g, " ")}
              {typeof c.arguments.thread === "string" ? ` ${c.arguments.thread}` : ""}
            </p>
          ) : null,
        )}
        {m.stopReason === "error" && m.errorMessage && <p className="text-xs text-destructive">{m.errorMessage}</p>}
      </div>
    );
  }
  return null;
}
