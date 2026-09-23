import type { AgentState, PermissionMode } from "@everywhere/protocol";
import { ArrowUpIcon, ChevronDownIcon, RotateCcwIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type AgentThread, useAgentThread } from "@/lib/agent";
import type { DevicePeer } from "@/lib/peer";
import { cn } from "@/lib/utils";
import { PendingRequest } from "./pending";
import { buildItems, Timeline } from "./timeline";

export const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: "default", label: "Ask before edits", hint: "Prompts for file edits and commands" },
  { value: "acceptEdits", label: "Accept edits", hint: "Edits files freely, asks before commands" },
  { value: "plan", label: "Plan", hint: "Researches and proposes a plan, changes nothing" },
  { value: "auto", label: "Auto", hint: "A classifier approves safe actions" },
  { value: "bypassPermissions", label: "Bypass permissions", hint: "Never asks. Only for sandboxes" },
];

export function AgentView({
  peer,
  threadId,
  generation,
  cwd,
}: {
  peer: DevicePeer;
  threadId: string;
  generation: number;
  /** The project directory, for showing paths relative to it. */
  cwd?: string;
}) {
  const agent = useAgentThread(peer, threadId, generation);
  const { state } = agent;
  const items = useMemo(() => buildItems(agent.events), [agent.events]);
  const busy = state?.status === "working" || state?.status === "waiting" || state?.status === "starting";

  // Follow new output while the user is at the bottom.
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4">
          {agent.truncated && (
            <p className="text-center text-xs text-muted-foreground">Older messages aren't shown.</p>
          )}
          {agent.synced && agent.events.length === 0 && <EmptyState />}
          <Timeline
            items={items}
            streaming={state?.streaming ?? []}
            cwd={cwd}
            working={state?.status === "working"}
          />
        </div>
      </div>

      <div className="shrink-0 border-t bg-background">
        <div className="mx-auto grid max-w-3xl gap-2 px-4 pt-2 pb-3">
          {state?.pending.map((r) => (
            <PendingRequest key={r.id} request={r} cwd={cwd} respond={agent.send} />
          ))}
          <StatusBar agent={agent} />
          <Composer agent={agent} busy={busy} />
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="py-16 text-center text-muted-foreground">
      <p className="text-[15px] text-foreground">Start a conversation with Claude</p>
      <p className="mt-1">It runs on this device, in the project directory, with your Claude login.</p>
    </div>
  );
}

function StatusBar({ agent }: { agent: AgentThread }) {
  const { state } = agent;
  if (agent.closed) {
    return (
      <Notice tone="error">
        <span className="flex-1">Disconnected from this thread.</span>
        <Button size="sm" variant="secondary" onClick={agent.reconnect}>
          <RotateCcwIcon />
          Reconnect
        </Button>
      </Notice>
    );
  }
  if (agent.error) {
    return (
      <Notice tone="error">
        <span className="flex-1 whitespace-pre-wrap">{agent.error}</span>
        <button type="button" onClick={agent.dismissError} aria-label="Dismiss">
          <XIcon className="size-3.5" />
        </button>
      </Notice>
    );
  }
  if (state?.status === "error" && state.error) {
    return (
      <Notice tone="error">
        <span className="flex-1 whitespace-pre-wrap">
          Claude stopped: {state.error}
          <span className="text-muted-foreground"> Send a message to start it again.</span>
        </span>
      </Notice>
    );
  }
  return null;
}

function Notice({ tone, children }: { tone: "error"; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-md px-3 py-2 text-[13px]",
        tone === "error" && "bg-destructive/10 text-destructive",
      )}
    >
      {children}
    </div>
  );
}

function Composer({ agent, busy }: { agent: AgentThread; busy: boolean }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const { state } = agent;
  const ready = agent.attached && agent.synced;

  // Grow with the text, up to a limit.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || !ready) return;
    agent.send({ t: "send", text: t });
    setText("");
  };

  return (
    <div className="rounded-lg border border-input bg-card focus-within:ring-2 focus-within:ring-ring/40">
      <textarea
        ref={ref}
        value={text}
        rows={1}
        autoFocus
        disabled={!ready}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape" && busy) {
            e.preventDefault();
            agent.send({ t: "interrupt" });
          }
        }}
        placeholder={
          !ready ? "Connecting…" : busy ? "Add to the current turn… (Esc to stop)" : "Ask Claude to do something…"
        }
        className="block max-h-60 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 outline-none placeholder:text-muted-foreground disabled:opacity-50"
      />
      <div className="flex items-center gap-1 px-1.5 pb-1.5">
        <ModeMenu state={state} disabled={!ready} onPick={(mode) => agent.send({ t: "setMode", mode })} />
        <ModelMenu state={state} disabled={!ready} onPick={(model) => agent.send({ t: "setModel", model })} />
        <StatusText state={state} />
        {busy ? (
          <Button
            size="icon-sm"
            variant="secondary"
            className="ml-auto size-7"
            onClick={() => agent.send({ t: "interrupt" })}
            aria-label="Stop"
            title="Stop (Esc)"
          >
            <SquareIcon className="fill-current" />
          </Button>
        ) : (
          <Button
            size="icon-sm"
            className="ml-auto size-7"
            disabled={!ready || !text.trim()}
            onClick={submit}
            aria-label="Send"
            title="Send (Enter)"
          >
            <ArrowUpIcon />
          </Button>
        )}
      </div>
    </div>
  );
}

function StatusText({ state }: { state: AgentState | null }) {
  const label =
    state?.status === "starting"
      ? "Starting Claude…"
      : state?.status === "waiting"
        ? "Waiting for you"
        : state?.status === "working"
          ? "Working…"
          : null;
  if (!label) return null;
  return (
    <span className={cn("ml-1 truncate text-xs", state?.status === "waiting" ? "text-warn" : "text-muted-foreground")}>
      {label}
    </span>
  );
}

function ModeMenu({
  state,
  disabled,
  onPick,
}: {
  state: AgentState | null;
  disabled: boolean;
  onPick: (m: PermissionMode) => void;
}) {
  const current = MODES.find((m) => m.value === state?.permissionMode) ?? MODES[0]!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-6 px-2 font-normal",
            current.value === "plan" && "text-primary",
            current.value === "bypassPermissions" && "text-destructive",
          )}
        >
          {current.label}
          <ChevronDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuLabel>Permissions</DropdownMenuLabel>
        {MODES.map((m) => (
          <DropdownMenuItem key={m.value} onSelect={() => onPick(m.value)}>
            <div className="grid">
              <span className={cn(m.value === current.value && "text-primary")}>{m.label}</span>
              <span className="text-xs text-muted-foreground">{m.hint}</span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModelMenu({
  state,
  disabled,
  onPick,
}: {
  state: AgentState | null;
  disabled: boolean;
  onPick: (model: string) => void;
}) {
  const models = state?.models ?? [];
  const configured = state?.model ?? "";
  const current = models.find((m) => m.value === (configured || "default"));
  const label = current?.displayName ?? (configured || "Default model");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled || models.length === 0}>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 max-w-48 px-2 font-normal"
          title={state?.activeModel ? `Running ${state.activeModel}` : undefined}
        >
          <span className="truncate">{label}</span>
          <ChevronDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        {models.map((m) => (
          <DropdownMenuItem key={m.value} onSelect={() => onPick(m.value === "default" ? "" : m.value)}>
            <div className="grid">
              <span className={cn(m === current && "text-primary")}>{m.displayName}</span>
              {m.description && <span className="text-xs text-muted-foreground">{m.description}</span>}
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
