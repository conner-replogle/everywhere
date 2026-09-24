import type { AgentCommand, AgentLimit, AgentModel, AgentState, PermissionMode } from "@everywhere/protocol";
import { ArrowUpIcon, ChevronDownIcon, PaperclipIcon, RotateCcwIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDevice } from "@/components/device-context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type AgentThread, useAgentThread } from "@/lib/agent";
import { listenComposer } from "@/lib/composer-inbox";
import { type DevicePeer, useRpc } from "@/lib/peer";
import { cn } from "@/lib/utils";
import {
  AttachmentChips,
  ContextMeter,
  matchCommands,
  ReasoningMenu,
  SlashMenu,
  UsageMeter,
  useAttachments,
  WorkspacePicker,
} from "./composer-parts";
import { PendingRequest } from "./pending";
import { buildItems, Timeline } from "./timeline";

export const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: "default", label: "Ask before edits", hint: "Prompts for file edits and commands" },
  { value: "acceptEdits", label: "Accept edits", hint: "Edits files freely, asks before commands" },
  { value: "plan", label: "Plan", hint: "Researches and proposes a plan, changes nothing" },
  { value: "auto", label: "Auto", hint: "A classifier approves safe actions" },
  { value: "bypassPermissions", label: "Bypass permissions", hint: "Never asks. Only for sandboxes" },
];

const BROWSER_TOOL = /^mcp__everywhere__browser_/;

export function AgentView({
  peer,
  threadId,
  projectId,
  generation,
  cwd,
  onBrowserUse,
}: {
  peer: DevicePeer;
  threadId: string;
  projectId: string;
  generation: number;
  /** The project directory, for showing paths relative to it. */
  cwd?: string;
  /** Called when claude starts driving the project's browser. */
  onBrowserUse?: () => void;
}) {
  const agent = useAgentThread(peer, threadId, generation);
  const { state } = agent;

  // Show the browser when claude uses it, but not for history being replayed.
  const seenSeq = useRef(0);
  const onBrowserUseRef = useRef(onBrowserUse);
  onBrowserUseRef.current = onBrowserUse;
  useEffect(() => {
    const fresh = agent.events.filter((e) => e.seq > seenSeq.current);
    if (!fresh.length) return;
    seenSeq.current = fresh[fresh.length - 1]!.seq;
    const used = fresh.some(
      (e) => e.event.type === "tool" && BROWSER_TOOL.test(e.event.name) && Date.now() - e.at < 30_000,
    );
    if (used) onBrowserUseRef.current?.();
  }, [agent.events]);
  const { info } = useDevice();
  const features = info.data?.features ?? [];
  // Before the thread has run, models and commands come from a probe of the device's claude.
  const needModels = features.includes("worktrees") && !!state && state.models.length === 0;
  const agentInfo = useRpc(peer, "agent.info", {}, [], needModels);
  const models = state?.models.length ? state.models : (agentInfo.data?.models ?? []);
  const commands = state?.commands?.length ? state.commands : (agentInfo.data?.commands ?? []);
  const limits = state?.limits?.length ? state.limits : agentInfo.data?.limits;
  const unlocked = !!state && !state.workspace.locked;
  const git = useRpc(peer, "git.info", { projectId }, [], unlocked && features.includes("worktrees"));
  // Paths are shown relative to wherever claude works: the worktree, if any.
  const workdir = state?.workspace.path || cwd;
  const items = useMemo(() => buildItems(agent.events), [agent.events]);
  const busy = state?.status === "working" || state?.status === "waiting" || state?.status === "starting";

  // Follow new output while the user is at the bottom.
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastTop = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={(e) => {
          const el = e.currentTarget;
          const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
          // Any upward scroll unpins, however small: a touch drag moves a few pixels per event,
          // and a distance threshold alone would snap it back to the bottom on every streamed token.
          if (gap <= 1) atBottom.current = true;
          else if (el.scrollTop < lastTop.current) atBottom.current = false;
          else if (gap < 40) atBottom.current = true;
          lastTop.current = el.scrollTop;
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
            cwd={workdir}
            working={state?.status === "working"}
          />
        </div>
      </div>

      <div className="shrink-0 border-t bg-background">
        <div className="mx-auto grid max-w-3xl gap-2 px-4 pt-2 pb-3">
          {state?.pending.map((r) => (
            <PendingRequest key={r.id} request={r} cwd={workdir} respond={agent.send} />
          ))}
          <StatusBar agent={agent} />
          <Composer
            agent={agent}
            busy={busy}
            peer={peer}
            threadId={threadId}
            models={models}
            commands={commands}
            limits={limits}
            git={git.data}
            canAttach={features.includes("attachments")}
          />
          {agentInfo.data && !agentInfo.data.available && (
            <p className="text-xs text-destructive">Claude isn't usable on this device: {agentInfo.data.error}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="py-16 text-center text-muted-foreground">
      <p className="text-[15px] text-foreground">Start a conversation with Claude</p>
      <p className="mt-1">
        It runs on this device with your Claude login, in the project directory or its own git worktree.
      </p>
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

function Composer({
  agent,
  busy,
  peer,
  threadId,
  models,
  commands,
  limits,
  git,
  canAttach,
}: {
  agent: AgentThread;
  busy: boolean;
  peer: DevicePeer;
  threadId: string;
  models: AgentModel[];
  commands: AgentCommand[];
  limits: AgentLimit[] | undefined;
  git: Parameters<typeof WorkspacePicker>[0]["git"];
  canAttach: boolean;
}) {
  const [text, setText] = useState("");
  // The "/" command menu: open while the text is a bare "/word".
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashTyped = /^\/(\S*)$/.exec(text)?.[1];
  const slashMatches = slashTyped === undefined || slashDismissed ? [] : matchCommands(commands, slashTyped);
  useEffect(() => setSlashIndex(0), [slashTyped]);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const files = useAttachments(peer, threadId);
  const { state } = agent;
  const ready = agent.attached && agent.synced;
  const suggestion = !busy && text === "" ? state?.suggestion : undefined;
  const model = models.find((m) => m.value === (state?.model || "default"));

  // Drafts from the thread's other panels, like browser annotations.
  const addFiles = files.add;
  useEffect(
    () =>
      listenComposer(threadId, (d) => {
        if (d.files.length) addFiles(d.files);
        if (d.text) setText((t) => (t.trim() ? `${t.trimEnd()}\n\n${d.text}` : d.text));
        ref.current?.focus();
      }),
    [threadId, addFiles],
  );

  const pickCommand = (c: AgentCommand) => {
    setText(`/${c.name} `);
    setSlashDismissed(false);
    ref.current?.focus();
  };

  // Grow with the text, up to a limit.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const canSend = ready && !files.uploading && (text.trim() !== "" || files.ready.length > 0);
  const submit = () => {
    if (!canSend) return;
    const attachments = files.ready.map((a) => a.id);
    agent.send({ t: "send", text: text.trim(), ...(attachments.length ? { attachments } : {}) });
    setText("");
    files.clear();
  };

  return (
    <div
      className={cn(
        "rounded-lg border border-input bg-card focus-within:ring-2 focus-within:ring-ring/40",
        dragging && "border-primary ring-2 ring-primary/40",
      )}
      onDragOver={(e) => {
        if (!canAttach || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        if (!canAttach || e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        files.add(e.dataTransfer.files);
      }}
    >
      <AttachmentChips items={files.items} onRemove={files.remove} />
      <SlashMenu matches={slashMatches} active={slashIndex} onPick={pickCommand} onHover={setSlashIndex} />
      <textarea
        ref={ref}
        value={text}
        rows={1}
        autoFocus
        disabled={!ready}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.startsWith("/")) setSlashDismissed(false);
        }}
        onPaste={(e) => {
          if (!canAttach || e.clipboardData.files.length === 0) return;
          e.preventDefault();
          files.add(e.clipboardData.files);
        }}
        onKeyDown={(e) => {
          if (slashMatches.length > 0) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const n = slashMatches.length;
              setSlashIndex((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
              return;
            }
            if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const c = slashMatches[slashIndex] ?? slashMatches[0];
              if (c) pickCommand(c);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setSlashDismissed(true);
              return;
            }
          }
          if (suggestion && (e.key === "Tab" || e.key === "ArrowRight")) {
            e.preventDefault();
            setText(suggestion);
            return;
          }
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape" && busy) {
            e.preventDefault();
            agent.send({ t: "interrupt" });
          }
        }}
        placeholder={
          !ready
            ? "Connecting…"
            : busy
              ? "Add to the current turn… (Esc to stop)"
              : suggestion
                ? `${suggestion}  (Tab to use)`
                : "Ask Claude to do something… (/ for commands)"
        }
        className="block max-h-60 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 outline-none placeholder:text-muted-foreground disabled:opacity-50"
      />
      <div className="flex min-w-0 flex-wrap items-center gap-1 px-1.5 pb-1.5">
        {canAttach && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6"
              disabled={!ready}
              onClick={() => fileInput.current?.click()}
              aria-label="Attach files"
              title="Attach files (or paste, or drop them here)"
            >
              <PaperclipIcon />
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) files.add(e.target.files);
                e.target.value = "";
              }}
            />
          </>
        )}
        <ModeMenu state={state} disabled={!ready} onPick={(mode) => agent.send({ t: "setMode", mode })} />
        <ModelMenu
          state={state}
          models={models}
          disabled={!ready}
          onPick={(model) => agent.send({ t: "setModel", model })}
        />
        {state?.thinking !== undefined && (
          <ReasoningMenu
            model={model}
            effort={state.effort ?? ""}
            thinking={state.thinking}
            disabled={!ready}
            onEffort={(effort) => agent.send({ t: "setEffort", effort })}
            onThinking={(thinking) => agent.send({ t: "setThinking", thinking })}
          />
        )}
        {state && (
          <WorkspacePicker
            workspace={state.workspace}
            git={git}
            disabled={!ready}
            onPick={(workspace, baseBranch) => agent.send({ t: "setWorkspace", workspace, baseBranch })}
          />
        )}
        <StatusText state={state} />
        <UsageMeter limits={limits} />
        <ContextMeter context={state?.context} />
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
            disabled={!canSend}
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
  models,
  disabled,
  onPick,
}: {
  state: AgentState | null;
  models: AgentModel[];
  disabled: boolean;
  onPick: (model: string) => void;
}) {
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
