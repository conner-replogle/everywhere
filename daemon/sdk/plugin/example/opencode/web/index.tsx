import { useEffect, useMemo, useRef, useState } from "react";
import { cn, usePlugin } from "everywhere";

// An OpenCode thread: the session's conversation, live from the server's
// events, and a composer. Tool calls fold; permission prompts and
// questions wait at the bottom for an answer.

type Info = {
  id: string;
  role: "user" | "assistant";
  time: { created: number; completed?: number };
  modelID?: string;
  providerID?: string;
  finish?: string;
  error?: { name: string; data?: { message?: string } };
};
type ToolState = {
  status: "pending" | "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: string;
  title?: string;
  error?: string;
};
type Part = {
  id: string;
  messageID: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  tool?: string;
  callID?: string;
  state?: ToolState;
  files?: string[];
  filename?: string;
  mime?: string;
};
type Message = { info: Info; parts: Part[] };
type Permission = { id: string; permission: string; patterns: string[]; metadata?: Record<string, unknown>; always?: string[] };
type Question = {
  id: string;
  questions: { question: string; header: string; options: { label: string; description: string }[]; multiple?: boolean }[];
};
type Todo = { content: string; status: string; priority: string };
type State = {
  session: { title?: string };
  directory: string;
  messages: Message[];
  status: { type: "idle" | "busy" | "retry"; message?: string };
  permissions: Permission[];
  questions: Question[];
};
type Models = { models: { id: string; name: string }[]; default: string; agents: string[] };
type TabState = { model?: string; agent?: string };

export default function OpenCode() {
  const plugin = usePlugin();
  const pane = plugin.pane.id;
  const args = { pane, threadId: plugin.threadId };
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [models, setModels] = useState<Models | null>(null);
  const saved = useMemo<TabState>(() => {
    try {
      return JSON.parse(plugin.tabState || "{}") as TabState;
    } catch {
      return {};
    }
  }, []);
  const [choice, setChoice] = useState<TabState>(saved);

  const load = () =>
    plugin
      .call<State>("opencode.state", args)
      .then((s) => {
        setState({ ...s, messages: s.messages ?? [], permissions: s.permissions ?? [], questions: s.questions ?? [] });
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    plugin.call<Models>("opencode.models", args).then(setModels, () => {});
  }, []);

  plugin.useEvent((e) => {
    if (e.event !== "opencode.event" || e.pane !== pane) return;
    const props = e.properties as Record<string, any>;
    const type = e.type as string;
    if (type === "todo.updated") return setTodos(props.todos ?? []);
    if (type === "session.error" && props.error?.name !== "MessageAbortedError") {
      setError(props.error?.data?.message ?? props.error?.name ?? "OpenCode failed");
    }
    setState((s) => (s ? apply(s, type, props) : s));
  });

  const send = async (text: string) => {
    setError(null);
    try {
      await plugin.call("opencode.prompt", { ...args, text, model: choice.model, agent: choice.agent });
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const choose = (c: TabState) => {
    const next = { ...choice, ...c };
    setChoice(next);
    plugin.setTabState(JSON.stringify(next));
  };

  if (!state) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-xs text-muted-foreground">
        {error ? (
          <div className="grid max-w-md gap-2">
            <p className="text-destructive">{error}</p>
            <button className="justify-self-center rounded-md border px-2 py-1" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : (
          "Starting OpenCode…"
        )}
      </div>
    );
  }
  const busy = state.status.type !== "idle";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Timeline messages={state.messages} busy={busy} />
      <div className="mx-auto grid w-full max-w-3xl gap-2 px-3 pb-3">
        {todos.some((t) => t.status !== "completed" && t.status !== "cancelled") && <Todos todos={todos} />}
        {state.status.type === "retry" && <p className="text-xs text-warn">Retrying: {state.status.message}</p>}
        {error && (
          <p className="flex items-start gap-2 rounded-md border border-destructive/40 px-2 py-1.5 text-xs text-destructive">
            <span className="flex-1 whitespace-pre-wrap">{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss">
              ×
            </button>
          </p>
        )}
        {state.permissions.map((p) => (
          <PermissionCard key={p.id} p={p} answer={(reply) => plugin.call("opencode.permission", { ...args, id: p.id, reply })} />
        ))}
        {state.questions.map((q) => (
          <QuestionCard key={q.id} q={q} answer={(a) => plugin.call("opencode.question", { ...args, id: q.id, ...a })} />
        ))}
        <Composer
          busy={busy}
          models={models}
          choice={choice}
          choose={choose}
          send={send}
          abort={() => void plugin.call("opencode.abort", args).catch((e: Error) => setError(e.message))}
        />
      </div>
    </div>
  );
}

/** One of the server's events, applied to what the view has. */
function apply(s: State, type: string, p: Record<string, any>): State {
  const withMessage = (id: string, fn: (m: Message) => Message): Message[] => {
    const i = s.messages.findIndex((m) => m.info.id === id);
    if (i < 0) return s.messages;
    const out = s.messages.slice();
    out[i] = fn(out[i]);
    return out;
  };
  switch (type) {
    case "message.updated": {
      const info = p.info as Info;
      const i = s.messages.findIndex((m) => m.info.id === info.id);
      if (i >= 0) return { ...s, messages: withMessage(info.id, (m) => ({ ...m, info })) };
      const messages = [...s.messages, { info, parts: [] }].sort((a, b) => (a.info.id < b.info.id ? -1 : 1));
      return { ...s, messages };
    }
    case "message.removed":
      return { ...s, messages: s.messages.filter((m) => m.info.id !== p.messageID) };
    case "message.part.updated": {
      const part = p.part as Part;
      let messages = s.messages;
      if (!messages.some((m) => m.info.id === part.messageID)) {
        // The part came first: a placeholder until its message does.
        messages = [...messages, { info: { id: part.messageID, role: "assistant", time: { created: Date.now() } }, parts: [] }];
      }
      return {
        ...s,
        messages: messages.map((m) => {
          if (m.info.id !== part.messageID) return m;
          const j = m.parts.findIndex((x) => x.id === part.id);
          const parts = j >= 0 ? m.parts.map((x) => (x.id === part.id ? part : x)) : [...m.parts, part];
          return { ...m, parts };
        }),
      };
    }
    case "message.part.removed":
      return { ...s, messages: withMessage(p.messageID, (m) => ({ ...m, parts: m.parts.filter((x) => x.id !== p.partID) })) };
    case "message.part.delta":
      return {
        ...s,
        messages: withMessage(p.messageID, (m) => ({
          ...m,
          parts: m.parts.map((x) =>
            x.id === p.partID ? { ...x, [p.field]: String((x as Record<string, unknown>)[p.field] ?? "") + p.delta } : x,
          ),
        })),
      };
    case "session.status":
      return { ...s, status: p.status };
    case "session.idle":
      return { ...s, status: { type: "idle" } };
    case "session.updated":
      return { ...s, session: p.info ?? s.session };
    case "permission.asked":
      return { ...s, permissions: [...s.permissions.filter((x) => x.id !== p.id), p as Permission] };
    case "permission.replied":
      return { ...s, permissions: s.permissions.filter((x) => x.id !== p.requestID) };
    case "question.asked":
      return { ...s, questions: [...s.questions.filter((x) => x.id !== p.id), p as Question] };
    case "question.replied":
    case "question.rejected":
      return { ...s, questions: s.questions.filter((x) => x.id !== p.requestID) };
  }
  return s;
}

// --- the conversation ---------------------------------------------------------

function Timeline({ messages, busy }: { messages: Message[]; busy: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <div
      ref={ref}
      className="min-h-0 flex-1 overflow-y-auto"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      <div className="mx-auto grid w-full max-w-3xl gap-3 px-3 py-4">
        {messages.length === 0 && (
          <p className="py-10 text-center text-xs text-muted-foreground">Ask OpenCode to do something in this thread's directory.</p>
        )}
        {messages.map((m) => (m.info.role === "user" ? <UserMessage key={m.info.id} m={m} /> : <AssistantMessage key={m.info.id} m={m} />))}
        {busy && <p className="animate-pulse text-xs text-muted-foreground">Working…</p>}
      </div>
    </div>
  );
}

function UserMessage({ m }: { m: Message }) {
  const text = m.parts
    .filter((p) => p.type === "text" && !p.synthetic)
    .map((p) => p.text)
    .join("\n");
  const files = m.parts.filter((p) => p.type === "file");
  if (!text && files.length === 0) return null;
  return (
    <div className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-[13px] whitespace-pre-wrap">
      {text}
      {files.map((f) => (
        <span key={f.id} className="mt-1 block text-[11px] text-muted-foreground">
          📎 {f.filename ?? f.mime}
        </span>
      ))}
    </div>
  );
}

function AssistantMessage({ m }: { m: Message }) {
  const err = m.info.error;
  return (
    <div className="grid gap-2">
      {m.parts.map((p) => {
        switch (p.type) {
          case "text":
            return p.text ? <Markdown key={p.id} text={p.text} /> : null;
          case "reasoning":
            return p.text ? <Reasoning key={p.id} text={p.text} /> : null;
          case "tool":
            return <ToolCall key={p.id} p={p} />;
          case "patch":
            return (
              <p key={p.id} className="text-[11px] text-muted-foreground">
                Changed {p.files?.length ?? 0} file{p.files?.length === 1 ? "" : "s"}
              </p>
            );
          default:
            return null;
        }
      })}
      {err && err.name !== "MessageAbortedError" && (
        <p className="text-xs text-destructive">{err.data?.message ?? err.name}</p>
      )}
      {err?.name === "MessageAbortedError" && <p className="text-xs text-muted-foreground">Stopped.</p>}
      {m.info.finish === "stop" && m.info.modelID && (
        <p className="text-[10px] text-muted-foreground/70">{m.info.modelID}</p>
      )}
    </div>
  );
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button className="text-left text-xs text-muted-foreground" onClick={() => setOpen(!open)}>
      <span className="italic">{open ? "▾" : "▸"} Thinking</span>
      {open && <span className="mt-1 block whitespace-pre-wrap">{text}</span>}
    </button>
  );
}

function ToolCall({ p }: { p: Part }) {
  const [open, setOpen] = useState(false);
  const s = p.state ?? { status: "pending" };
  const title = s.title || summary(p.tool ?? "tool", s.input);
  const mark = s.status === "completed" ? "✓" : s.status === "error" ? "✗" : "…";
  return (
    <div className="rounded-md border text-xs">
      <button className="flex w-full items-center gap-2 px-2 py-1.5 text-left" onClick={() => setOpen(!open)}>
        <span className={cn("w-3 shrink-0", s.status === "error" ? "text-destructive" : s.status === "completed" ? "text-live" : "animate-pulse")}>
          {mark}
        </span>
        <span className="shrink-0 font-medium">{p.tool}</span>
        <span className="min-w-0 truncate font-mono text-muted-foreground">{title}</span>
      </button>
      {open && (
        <div className="grid gap-1 border-t px-2 py-1.5">
          {s.input && Object.keys(s.input).length > 0 && (
            <pre className="max-h-48 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
              {JSON.stringify(s.input, null, 2)}
            </pre>
          )}
          {s.output && <pre className="max-h-72 overflow-auto font-mono text-[11px] whitespace-pre-wrap">{s.output}</pre>}
          {s.error && <pre className="font-mono text-[11px] whitespace-pre-wrap text-destructive">{s.error}</pre>}
        </div>
      )}
    </div>
  );
}

function summary(tool: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const v = input.command ?? input.filePath ?? input.path ?? input.pattern ?? input.url ?? input.description;
  return typeof v === "string" ? v : tool;
}

/** Enough Markdown for chat: paragraphs, code blocks, inline code, bold, lists, headings. */
function Markdown({ text }: { text: string }) {
  const blocks = text.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g);
  return (
    <div className="grid gap-2 text-[13px] leading-relaxed">
      {blocks.map((b, i) => {
        if (b.startsWith("```")) {
          const body = b.replace(/^```[^\n]*\n/, "").replace(/```$/, "");
          return (
            <pre key={i} className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-[12px]">
              {body}
            </pre>
          );
        }
        return b
          .split(/\n{2,}/)
          .filter((para) => para.trim())
          .map((para, j) => {
            const heading = /^(#{1,4})\s+(.*)$/.exec(para.trim());
            if (heading) {
              return (
                <p key={`${i}-${j}`} className="font-semibold">
                  {inline(heading[2])}
                </p>
              );
            }
            const lines = para.split("\n");
            if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))) {
              return (
                <ul key={`${i}-${j}`} className="grid list-disc gap-0.5 pl-5">
                  {lines.map((l, k) => (
                    <li key={k}>{inline(l.replace(/^\s*([-*]|\d+\.)\s/, ""))}</li>
                  ))}
                </ul>
              );
            }
            return (
              <p key={`${i}-${j}`} className="whitespace-pre-wrap">
                {inline(para)}
              </p>
            );
          });
      })}
    </div>
  );
}

function inline(s: string) {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((t, i) => {
    if (t.startsWith("`") && t.endsWith("`") && t.length > 1) {
      return (
        <code key={i} className="rounded bg-muted px-1 font-mono text-[12px]">
          {t.slice(1, -1)}
        </code>
      );
    }
    if (t.startsWith("**") && t.endsWith("**") && t.length > 3) return <strong key={i}>{t.slice(2, -2)}</strong>;
    return t;
  });
}

// --- waiting on the user ---------------------------------------------------------

function PermissionCard({ p, answer }: { p: Permission; answer: (reply: "once" | "always" | "reject") => Promise<unknown> }) {
  const [sending, setSending] = useState(false);
  const reply = async (r: "once" | "always" | "reject") => {
    setSending(true);
    try {
      await answer(r);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="grid gap-2 rounded-md border border-warn/50 bg-card px-3 py-2 text-xs">
      <p>
        OpenCode wants to <strong>{p.permission}</strong>
      </p>
      {p.patterns.length > 0 && (
        <pre className="max-h-32 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">{p.patterns.join("\n")}</pre>
      )}
      <div className="flex flex-wrap gap-2">
        <button disabled={sending} className="rounded-md bg-primary px-2 py-1 text-primary-foreground" onClick={() => void reply("once")}>
          Allow once
        </button>
        {(p.always?.length ?? 0) > 0 && (
          <button disabled={sending} className="rounded-md border px-2 py-1" onClick={() => void reply("always")} title={p.always?.join(", ")}>
            Always allow
          </button>
        )}
        <button disabled={sending} className="rounded-md border px-2 py-1 text-destructive" onClick={() => void reply("reject")}>
          Reject
        </button>
      </div>
    </div>
  );
}

function QuestionCard({ q, answer }: { q: Question; answer: (a: { answers?: string[][]; reject?: boolean }) => Promise<unknown> }) {
  const [picked, setPicked] = useState<string[][]>(q.questions.map(() => []));
  const toggle = (i: number, label: string, multiple?: boolean) =>
    setPicked((ps) =>
      ps.map((p, j) => (j !== i ? p : multiple ? (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]) : [label])),
    );
  const ready = picked.every((p) => p.length > 0);
  return (
    <div className="grid gap-3 rounded-md border border-warn/50 bg-card px-3 py-2 text-xs">
      {q.questions.map((qq, i) => (
        <div key={i} className="grid gap-1.5">
          <p className="font-medium">{qq.question}</p>
          <div className="flex flex-wrap gap-1.5">
            {qq.options.map((o) => (
              <button
                key={o.label}
                title={o.description}
                className={cn("rounded-md border px-2 py-1", picked[i].includes(o.label) && "border-primary bg-primary/10")}
                onClick={() => toggle(i, o.label, qq.multiple)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <button
          disabled={!ready}
          className="rounded-md bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50"
          onClick={() => void answer({ answers: picked })}
        >
          Answer
        </button>
        <button className="rounded-md border px-2 py-1" onClick={() => void answer({ reject: true })}>
          Skip
        </button>
      </div>
    </div>
  );
}

function Todos({ todos }: { todos: Todo[] }) {
  return (
    <ul className="grid gap-0.5 rounded-md border px-3 py-2 text-xs">
      {todos.map((t, i) => (
        <li key={i} className={cn(t.status === "completed" && "text-muted-foreground line-through", t.status === "in_progress" && "font-medium")}>
          {t.status === "completed" ? "☑" : t.status === "in_progress" ? "▸" : "☐"} {t.content}
        </li>
      ))}
    </ul>
  );
}

// --- the composer -----------------------------------------------------------------

function Composer({
  busy,
  models,
  choice,
  choose,
  send,
  abort,
}: {
  busy: boolean;
  models: Models | null;
  choice: TabState;
  choose: (c: TabState) => void;
  send: (text: string) => Promise<boolean>;
  abort: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const submit = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    if (await send(t)) setText("");
    setSending(false);
  };
  const model = choice.model ?? models?.default ?? "";
  return (
    <div className="grid gap-1.5 rounded-lg border bg-card p-2">
      <textarea
        value={text}
        rows={Math.min(8, Math.max(2, text.split("\n").length))}
        placeholder="Ask OpenCode…"
        className="resize-none bg-transparent px-1 text-[13px] outline-none"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="flex items-center gap-2 text-[11px]">
        {models && models.agents.length > 0 && (
          <select
            className="rounded border bg-background px-1 py-0.5"
            value={choice.agent ?? models.agents[0]}
            onChange={(e) => choose({ agent: e.target.value })}
            aria-label="Agent"
          >
            {models.agents.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        )}
        {models && (
          <select
            className="min-w-0 max-w-[16rem] truncate rounded border bg-background px-1 py-0.5"
            value={model}
            onChange={(e) => choose({ model: e.target.value })}
            aria-label="Model"
          >
            {!models.models.some((m) => m.id === model) && <option value={model}>{model || "OpenCode's default model"}</option>}
            {models.models
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        )}
        <span className="flex-1" />
        {busy ? (
          <button className="rounded-md border px-2 py-1" onClick={abort}>
            Stop
          </button>
        ) : (
          <button
            disabled={!text.trim() || sending}
            className="rounded-md bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50"
            onClick={() => void submit()}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
