import type { AgentClientMsg, AgentRequest } from "@everywhere/protocol";
import { CheckIcon, MessageCircleQuestionIcon, ShieldCheckIcon } from "lucide-react";
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

function Card({
  title,
  icon,
  tone = "warn",
  children,
}: {
  title: React.ReactNode;
  icon: React.ReactNode;
  /** warn for permission prompts; neutral for questions, which aren't a risk. */
  tone?: "warn" | "neutral";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex max-h-[70dvh] flex-col rounded-lg border bg-card shadow-lg shadow-black/20",
        tone === "warn" ? "border-warn/40" : "border-border",
      )}
    >
      <div
        className={cn(
          "flex shrink-0 items-center gap-2 border-b px-3 py-2",
          tone === "warn" ? "border-warn/20 text-warn" : "border-border text-foreground",
        )}
      >
        {icon}
        <span className="min-w-0 truncate font-medium">{title}</span>
      </div>
      <div className="grid min-h-0 gap-2.5 overflow-y-auto px-3 py-2.5">{children}</div>
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
  // One question at a time; Back and the steps above go to earlier ones.
  const [step, setStep] = useState(0);

  const answerFor = (q: Question) => [...(picked[q.question] ?? []), other[q.question]?.trim()].filter(Boolean).join(", ");
  const complete = questions.every((q) => answerFor(q) !== "");
  const q = questions[Math.min(step, questions.length - 1)];
  const last = step >= questions.length - 1;

  const submit = () =>
    respond({
      t: "respond",
      requestId: request.id,
      decision: "allow",
      answers: Object.fromEntries(questions.map((q) => [q.question, answerFor(q)])),
    });
  const next = () => {
    if (!q || answerFor(q) === "") return;
    if (!last) setStep(step + 1);
    else if (complete) submit();
  };

  const toggle = (q: Question, label: string) => {
    const cur = picked[q.question] ?? [];
    const on = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
    setPicked((prev) => ({ ...prev, [q.question]: on }));
    // A single choice moves on by itself, except on the last, which waits for Submit.
    if (!q.multiSelect && !last) setStep(step + 1);
  };

  if (!q) return null;
  return (
    <Card
      tone="neutral"
      icon={<MessageCircleQuestionIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      title={
        questions.length > 1 ? (
          <>
            Claude has {questions.length} questions
            <span className="ml-2 font-normal text-muted-foreground">
              {step + 1} of {questions.length}
            </span>
          </>
        ) : (
          "Claude has a question"
        )
      }
    >
      {questions.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {questions.map((x, i) => (
            <button
              key={x.question}
              type="button"
              onClick={() => setStep(i)}
              className={cn(
                "flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground",
                i === step ? "bg-secondary text-foreground" : "bg-transparent",
              )}
            >
              {answerFor(x) !== "" && <CheckIcon className="size-3" />}
              {x.header || `Question ${i + 1}`}
            </button>
          ))}
        </div>
      )}
      <fieldset key={q.question} className="grid min-h-0 gap-1.5">
        <legend className="mb-1.5">
          {q.header && questions.length === 1 && (
            <span className="mr-2 rounded-sm bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">{q.header}</span>
          )}
          {q.question}
        </legend>
        <div className="-mx-1 grid max-h-[min(22rem,45dvh)] gap-1 overflow-y-auto px-1 py-0.5">
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
                  on && "border-primary/60 bg-primary/10",
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
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              next();
            }}
            placeholder="Other…"
            className="h-7 shrink-0 rounded-md border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          />
        </div>
      </fieldset>
      <div className="flex items-center gap-2">
        {step > 0 && (
          <Button size="sm" variant="secondary" onClick={() => setStep(step - 1)}>
            Back
          </Button>
        )}
        {last ? (
          <Button size="sm" disabled={!complete} onClick={submit}>
            Submit
          </Button>
        ) : (
          <Button size="sm" disabled={answerFor(q) === ""} onClick={next}>
            Next
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
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
