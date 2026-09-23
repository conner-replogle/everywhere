import type { AgentClientMsg, AgentRequest } from "@everywhere/protocol";
import { ShieldCheckIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";
import { asInput, EditPreview, isEdit, toolIcon, toolLabel, toolSummary } from "./tools";

type Respond = (msg: Extract<AgentClientMsg, { t: "respond" }>) => void;

/** A prompt waiting for the user, pinned above the composer. */
export function PendingRequest({ request, cwd, respond }: { request: AgentRequest; cwd?: string; respond: Respond }) {
  switch (request.kind) {
    case "question":
      return <QuestionCard request={request} respond={respond} />;
    case "plan":
      return <PlanCard request={request} respond={respond} />;
    default:
      return <ToolCard request={request} cwd={cwd} respond={respond} />;
  }
}

function Card({ title, icon, children }: { title: React.ReactNode; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-warn/40 bg-card shadow-lg shadow-black/20">
      <div className="flex items-center gap-2 border-b border-warn/20 px-3 py-2 text-warn">
        {icon}
        <span className="min-w-0 truncate font-medium">{title}</span>
      </div>
      <div className="grid gap-2.5 px-3 py-2.5">{children}</div>
    </div>
  );
}

/** Deny with optional feedback; Enter in the box submits. */
function DenyBox({ label, placeholder, onDeny }: { label: string; placeholder: string; onDeny: (m: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="flex min-w-0 flex-1 gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onDeny(text.trim());
      }}
    >
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      />
      <Button type="submit" size="sm" variant="outline">
        {label}
      </Button>
    </form>
  );
}

function ToolCard({ request, cwd, respond }: { request: AgentRequest; cwd?: string; respond: Respond }) {
  const input = asInput(request.input);
  const Icon = toolIcon(request.toolName);
  const summary = toolSummary(request.toolName, input, cwd);
  const decide = (decision: "allow" | "allowSession" | "deny", message?: string) =>
    respond({ t: "respond", requestId: request.id, decision, message });

  return (
    <Card
      icon={<ShieldCheckIcon className="size-3.5 shrink-0" />}
      title={request.title || `Claude wants to use ${toolLabel(request.toolName)}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-mono text-xs">{summary || request.description}</span>
      </div>
      {isEdit(request.toolName) ? (
        <EditPreview name={request.toolName} input={input} className="max-h-72 overflow-y-auto" />
      ) : request.toolName === "Bash" ? (
        <pre className="max-h-48 overflow-auto rounded-md border bg-terminal px-3 py-2 font-mono text-xs whitespace-pre-wrap">
          $ {String(input.command ?? "")}
        </pre>
      ) : null}
      {request.decisionReason && <p className="text-xs text-muted-foreground">{request.decisionReason}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => decide("allow")} autoFocus>
          Allow
        </Button>
        {request.canAllowSession && (
          <Button size="sm" variant="secondary" onClick={() => decide("allowSession")}>
            Allow for this session
          </Button>
        )}
        <DenyBox label="Deny" placeholder="Tell Claude what to do instead (optional)" onDeny={(m) => decide("deny", m)} />
      </div>
    </Card>
  );
}

interface Question {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

function parseQuestions(input: unknown): Question[] {
  const qs = asInput(input).questions;
  if (!Array.isArray(qs)) return [];
  return qs.map((q) => {
    const o = asInput(q);
    return {
      question: String(o.question ?? ""),
      header: String(o.header ?? ""),
      multiSelect: o.multiSelect === true,
      options: (Array.isArray(o.options) ? o.options : []).map((opt) => {
        const a = asInput(opt);
        return { label: String(a.label ?? ""), description: typeof a.description === "string" ? a.description : undefined };
      }),
    };
  });
}

function QuestionCard({ request, respond }: { request: AgentRequest; respond: Respond }) {
  const questions = parseQuestions(request.input);
  // Selected option labels and free-text "other" answers, per question.
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const answerFor = (q: Question) => [...(picked[q.question] ?? []), other[q.question]?.trim()].filter(Boolean).join(", ");
  const complete = questions.every((q) => answerFor(q) !== "");

  const toggle = (q: Question, label: string) =>
    setPicked((prev) => {
      const cur = prev[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
      return { ...prev, [q.question]: next };
    });

  return (
    <Card icon={<ShieldCheckIcon className="size-3.5 shrink-0" />} title="Claude has a question">
      {questions.map((q) => (
        <fieldset key={q.question} className="grid gap-1.5">
          <legend className="mb-1.5">
            {q.header && (
              <span className="mr-2 rounded-sm bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">{q.header}</span>
            )}
            {q.question}
          </legend>
          <div className="grid gap-1">
            {q.options.map((o) => {
              const on = picked[q.question]?.includes(o.label) ?? false;
              return (
                <button
                  key={o.label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(q, o.label)}
                  className={cn(
                    "rounded-md border px-2.5 py-1.5 text-left hover:bg-accent/60",
                    on && "border-primary bg-primary/10",
                  )}
                >
                  <div className="font-medium">{o.label}</div>
                  {o.description && <div className="text-xs text-muted-foreground">{o.description}</div>}
                </button>
              );
            })}
            <input
              value={other[q.question] ?? ""}
              onChange={(e) => setOther((prev) => ({ ...prev, [q.question]: e.target.value }))}
              placeholder="Other…"
              className="h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
            />
          </div>
        </fieldset>
      ))}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!complete}
          onClick={() =>
            respond({
              t: "respond",
              requestId: request.id,
              decision: "allow",
              answers: Object.fromEntries(questions.map((q) => [q.question, answerFor(q)])),
            })
          }
        >
          Answer
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => respond({ t: "respond", requestId: request.id, decision: "deny", message: "The user skipped the question." })}
        >
          Skip
        </Button>
      </div>
    </Card>
  );
}

function PlanCard({ request, respond }: { request: AgentRequest; respond: Respond }) {
  const input = asInput(request.input);
  const plan = typeof input.plan === "string" ? input.plan : "";
  const decide = (decision: "allow" | "allowSession" | "deny", message?: string) =>
    respond({ t: "respond", requestId: request.id, decision, message });
  return (
    <Card icon={<ShieldCheckIcon className="size-3.5 shrink-0" />} title="Claude's plan is ready">
      {plan && <Markdown text={plan} className="max-h-80 overflow-y-auto rounded-md border px-3 py-2" />}
      <div className="flex flex-wrap items-center gap-2">
        {request.canAllowSession && (
          <Button size="sm" onClick={() => decide("allowSession")} title="Leaves plan mode and accepts file edits">
            Approve, auto-accept edits
          </Button>
        )}
        <Button size="sm" variant={request.canAllowSession ? "secondary" : "default"} onClick={() => decide("allow")}>
          Approve
        </Button>
        <DenyBox label="Keep planning" placeholder="What should change?" onDeny={(m) => decide("deny", m)} />
      </div>
    </Card>
  );
}
