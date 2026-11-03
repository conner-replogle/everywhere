import { useEffect, useMemo, useState, type ReactNode } from "react";
import { usePlugin, type Plugin } from "everywhere";
import { Button, Initials, LabelChip, Markdown, PriorityIcon, StateIcon } from "./bits";
import { ago, errorText, stateRank, type Issue, type IssueDetail, type Link, type State, type TabState } from "./types";

// The Linear tab: the issues of the Linear project or team the thread's
// project is linked to, and one issue's page beside them (or instead of
// them, when narrow).
export default function LinearTab() {
  const plugin = usePlugin();
  const [status, setStatus] = useState<{ configured: boolean; error?: string; viewer?: { name: string } }>();
  const [link, setLink] = useState<{ projectId: string; threadKind: string; link: Link | null }>();
  const [error, setError] = useState<string>();
  const [picking, setPicking] = useState(false);

  const load = () => {
    setError(undefined);
    plugin.call<typeof status>("linear.status").then(setStatus, (e) => setError(errorText(e)));
    plugin.call<typeof link>("linear.link.get", { threadId: plugin.threadId }).then(setLink, (e) => setError(errorText(e)));
  };
  useEffect(load, []);
  plugin.useEvent((e) => {
    if (e.event === "linear.kv.changed" && link && e.scope === `project:${link.projectId}`) load();
    if (e.event === "linear.changed" && e.issue === "") load(); // settings changed
  });

  if (error) return <Message title="Couldn't load Linear" detail={error} action={<Button onClick={load}>Try again</Button>} />;
  if (!status || !link) return <Message title="Loading…" />;
  if (!status.configured)
    return (
      <Message
        title="Connect Linear"
        detail="Create a personal API key in Linear (Settings → Security & access → Personal API keys) and add it in everywhere's Settings → Plugins → Linear."
        action={<Button onClick={() => plugin.openUrl("https://linear.app/settings/account/security")}>Open Linear's settings</Button>}
      />
    );
  if (status.error) return <Message title="Linear refused" detail={status.error} action={<Button onClick={load}>Try again</Button>} />;
  if (!link.projectId) return <Message title="Not in a project" detail="Open this tab in a thread of a project to link it to Linear." />;
  if (!link.link || picking)
    return (
      <LinkPicker
        plugin={plugin}
        current={link.link}
        onCancel={link.link ? () => setPicking(false) : undefined}
        onPick={async (l) => {
          await plugin.call("linear.link.set", { threadId: plugin.threadId, link: l });
          setPicking(false);
          load();
        }}
      />
    );
  return <Issues plugin={plugin} link={link.link} agent={link.threadKind !== "terminal"} onRelink={() => setPicking(true)} />;
}

function Message({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-sm space-y-2 text-center">
        <p className="font-medium">{title}</p>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
        {action && <div className="pt-1">{action}</div>}
      </div>
    </div>
  );
}

// --- linking ---------------------------------------------------------------------

function LinkPicker({ plugin, current, onPick, onCancel }: { plugin: Plugin; current: Link | null; onPick: (l: Link | null) => Promise<void>; onCancel?: () => void }) {
  const [targets, setTargets] = useState<Link[]>();
  const [error, setError] = useState<string>();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    plugin.call<Link[]>("linear.targets").then(setTargets, (e) => setError(errorText(e)));
  }, []);
  const shown = (targets ?? []).filter((t) => t.name.toLowerCase().includes(q.toLowerCase()));
  const pick = async (l: Link | null) => {
    setBusy(true);
    try {
      await onPick(l);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto flex h-full max-w-lg flex-col gap-3 p-4">
      <div>
        <p className="font-medium">Link this project to Linear</p>
        <p className="text-xs text-muted-foreground">Its threads' Linear tab shows that project's or team's issues, and their agents can read them.</p>
      </div>
      <input
        autoFocus
        className="rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring/50"
        placeholder="Search projects and teams"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
        {!targets && !error && <p className="p-3 text-xs text-muted-foreground">Loading…</p>}
        {targets && shown.length === 0 && <p className="p-3 text-xs text-muted-foreground">Nothing matches.</p>}
        {(["project", "team"] as const).map((type) => {
          const group = shown.filter((t) => t.type === type);
          if (!group.length) return null;
          return (
            <div key={type}>
              <p className="sticky top-0 bg-muted px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {type === "project" ? "Projects" : "Teams (all their issues)"}
              </p>
              {group.map((t) => (
                <button
                  key={t.id}
                  disabled={busy}
                  onClick={() => pick({ type: t.type, id: t.id, name: t.name, url: t.url })}
                  className={"block w-full px-3 py-1.5 text-left text-sm hover:bg-muted " + (current?.id === t.id ? "font-medium text-primary" : "")}
                >
                  {t.name}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div className="flex justify-end gap-2">
        {current && (
          <Button disabled={busy} onClick={() => pick(null)}>
            Unlink
          </Button>
        )}
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
      </div>
    </div>
  );
}

// --- the list --------------------------------------------------------------------

function readTabState(s: string | undefined): TabState {
  try {
    return s ? (JSON.parse(s) as TabState) : {};
  } catch {
    return {};
  }
}

function Issues({ plugin, link, agent, onRelink }: { plugin: Plugin; link: Link; agent: boolean; onRelink: () => void }) {
  const [tab, setTab] = useState<TabState>(() => readTabState(plugin.tabState));
  const save = (next: TabState) => {
    setTab(next);
    plugin.setTabState(JSON.stringify(next));
  };
  const [issues, setIssues] = useState<Issue[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");

  const load = () => {
    setLoading(true);
    plugin
      .call<Issue[]>("linear.issues", { threadId: plugin.threadId, mine: !!tab.mine, closed: !!tab.closed })
      .then(
        (r) => {
          setIssues(r);
          setError(undefined);
        },
        (e) => setError(errorText(e)),
      )
      .finally(() => setLoading(false));
  };
  useEffect(load, [link.id, tab.mine, tab.closed]);
  plugin.useEvent((e) => {
    if (e.event === "linear.changed") load();
  });

  const groups = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = (issues ?? []).filter((i) => {
      const hay = `${i.identifier} ${i.title} ${i.assignee?.name ?? ""} ${i.labels.nodes.map((l) => l.name).join(" ")}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const byState = new Map<string, { state: State; issues: Issue[] }>();
    for (const i of shown) {
      const g = byState.get(i.state.id) ?? { state: i.state, issues: [] };
      g.issues.push(i);
      byState.set(i.state.id, g);
    }
    const out = [...byState.values()].sort((a, b) => stateRank(a.state) - stateRank(b.state));
    for (const g of out) g.issues.sort((a, b) => (a.priority || 5) - (b.priority || 5) || b.updatedAt.localeCompare(a.updatedAt));
    return out;
  }, [issues, q]);

  const open = (identifier: string | undefined) => save({ ...tab, issue: identifier });

  return (
    <div className="flex h-full min-h-0">
      <div className={"flex min-w-0 flex-col border-r md:w-[min(26rem,45%)] " + (tab.issue ? "hidden md:flex" : "flex flex-1 md:flex-none")}>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <button className="min-w-0 truncate text-left text-sm font-medium hover:underline" title="Link another project or team" onClick={onRelink}>
            {link.name}
          </button>
          <span className="flex-1" />
          {link.url && (
            <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => plugin.openUrl(link.url!)}>
              Open ↗
            </button>
          )}
          <button className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50" disabled={loading} onClick={load}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
          <input
            className="min-w-24 flex-1 rounded-md bg-muted px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-ring/50"
            placeholder="Filter"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Toggle on={!!tab.mine} onClick={() => save({ ...tab, mine: !tab.mine })}>
            Mine
          </Toggle>
          <Toggle on={!!tab.closed} onClick={() => save({ ...tab, closed: !tab.closed })}>
            Closed
          </Toggle>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error && <p className="p-3 text-xs text-destructive">{error}</p>}
          {!issues && !error && <p className="p-3 text-xs text-muted-foreground">Loading issues…</p>}
          {issues && groups.length === 0 && <p className="p-3 text-xs text-muted-foreground">{q ? "Nothing matches." : "No open issues."}</p>}
          {groups.map((g) => (
            <div key={g.state.id}>
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-muted/80 px-3 py-1 text-xs font-medium backdrop-blur">
                <StateIcon state={g.state} size={12} />
                {g.state.name}
                <span className="text-muted-foreground">{g.issues.length}</span>
              </div>
              {g.issues.map((i) => (
                <button
                  key={i.id}
                  onClick={() => open(i.identifier)}
                  className={"flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted " + (tab.issue === i.identifier ? "bg-muted" : "")}
                >
                  <PriorityIcon priority={i.priority} label={i.priorityLabel} />
                  <span className="w-16 shrink-0 font-mono text-[11px] text-muted-foreground">{i.identifier}</span>
                  <span className="min-w-0 flex-1 truncate">{i.title}</span>
                  {i.labels.nodes.slice(0, 1).map((l) => (
                    <span key={l.name} className="hidden lg:inline-flex">
                      <LabelChip {...l} />
                    </span>
                  ))}
                  {i.assignee && <Initials name={i.assignee.name} />}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className={"min-w-0 flex-1 " + (tab.issue ? "flex" : "hidden md:flex")}>
        {tab.issue ? (
          <IssuePage key={tab.issue} plugin={plugin} id={tab.issue} agent={agent} onBack={() => open(undefined)} onOpen={open} />
        ) : (
          <Message title="Pick an issue" detail="Its description, comments and status show here." />
        )}
      </div>
    </div>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={"rounded-md border px-2 py-0.5 text-xs " + (on ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")}
    >
      {children}
    </button>
  );
}

// --- an issue ----------------------------------------------------------------------

function IssuePage({ plugin, id, agent, onBack, onOpen }: { plugin: Plugin; id: string; agent: boolean; onBack: () => void; onOpen: (id: string) => void }) {
  const [issue, setIssue] = useState<IssueDetail>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<string>();
  const [comment, setComment] = useState("");

  const load = () =>
    plugin.call<IssueDetail>("linear.issue", { id }).then(
      (r) => {
        setIssue(r);
        setError(undefined);
      },
      (e) => setError(errorText(e)),
    );
  useEffect(() => void load(), [id]);
  plugin.useEvent((e) => {
    if (e.event === "linear.changed" && (e.issue === issue?.id || e.issue === "")) void load();
  });

  const run = async (what: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(what);
    setNote(undefined);
    try {
      await fn();
      if (done) setNote(done);
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(undefined);
    }
  };

  const back = (
    <button className="text-xs text-muted-foreground hover:text-foreground md:hidden" onClick={onBack}>
      ← Issues
    </button>
  );
  if (error)
    return (
      <div className="flex-1 space-y-2 p-4">
        {back}
        <p className="text-xs text-destructive">{error}</p>
      </div>
    );
  if (!issue)
    return (
      <div className="flex-1 space-y-2 p-4">
        {back}
        <p className="text-xs text-muted-foreground">Loading {id}…</p>
      </div>
    );

  const states = [...issue.states].sort((a, b) => stateRank(a) - stateRank(b));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-4">
        <div className="flex items-center gap-3">
          {back}
          <span className="font-mono text-xs text-muted-foreground">{issue.identifier}</span>
          {issue.parent && (
            <button className="min-w-0 truncate text-xs text-muted-foreground hover:text-foreground" onClick={() => onOpen(issue.parent!.identifier)}>
              ↑ {issue.parent.identifier} {issue.parent.title}
            </button>
          )}
          <span className="flex-1" />
          <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => plugin.openUrl(issue.url)}>
            Open in Linear ↗
          </button>
        </div>
        <h1 className="text-lg font-semibold leading-snug">{issue.title}</h1>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1">
            <StateIcon state={issue.state} size={12} />
            <select
              className="bg-transparent outline-none"
              value={issue.state.id}
              disabled={!!busy}
              onChange={(e) => {
                const stateId = e.target.value;
                void run("state", () => plugin.call("linear.setState", { issueId: issue.id, stateId }));
              }}
            >
              {states.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <span className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1">
            <PriorityIcon priority={issue.priority} label={issue.priorityLabel} />
            {issue.priorityLabel}
          </span>
          {issue.assignee ? (
            <span className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1">
              <Initials name={issue.assignee.name} />
              {issue.assignee.name}
            </span>
          ) : (
            <Button disabled={!!busy} onClick={() => run("assign", () => plugin.call("linear.assignMe", { issueId: issue.id }))}>
              Assign to me
            </Button>
          )}
          {issue.labels.nodes.map((l) => (
            <LabelChip key={l.name} {...l} />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {agent && (
            <Button
              primary
              disabled={!!busy}
              onClick={() => run("work", () => plugin.call("linear.work", { threadId: plugin.threadId, id: issue.identifier }), "Sent to the agent.")}
            >
              {busy === "work" ? "Sending…" : "Work on this"}
            </Button>
          )}
          {issue.branchName && (
            <span className="truncate font-mono text-[11px] text-muted-foreground" title="Its branch name">
              ⎇ {issue.branchName}
            </span>
          )}
          {note && <span className="text-xs text-muted-foreground">{note}</span>}
        </div>

        <div className="rounded-md border p-3">
          {issue.description.trim() ? (
            <Markdown text={issue.description} openUrl={plugin.openUrl} />
          ) : (
            <p className="text-xs text-muted-foreground">No description.</p>
          )}
        </div>

        {issue.children.nodes.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Sub-issues</p>
            <div className="rounded-md border">
              {issue.children.nodes.map((c) => (
                <button key={c.identifier} onClick={() => onOpen(c.identifier)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted">
                  <StateIcon state={c.state} size={12} />
                  <span className="w-16 shrink-0 font-mono text-[11px] text-muted-foreground">{c.identifier}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{c.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground">
            Activity · created {ago(issue.createdAt)}
            {issue.creator ? ` by ${issue.creator.name}` : ""}
          </p>
          {issue.comments.nodes.map((c) => (
            <div key={c.id} className="flex gap-2">
              <Initials name={c.user?.name ?? "?"} />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-xs">
                  <span className="font-medium">{c.user?.name ?? "Someone"}</span> <span className="text-muted-foreground">{ago(c.createdAt)}</span>
                </p>
                <Markdown text={c.body} openUrl={plugin.openUrl} />
              </div>
            </div>
          ))}
          <div className="space-y-2">
            <textarea
              className="min-h-20 w-full resize-y rounded-md border bg-background p-2 text-[13px] outline-none focus:ring-2 focus:ring-ring/50"
              placeholder="Leave a comment…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && comment.trim()) {
                  e.preventDefault();
                  void run("comment", async () => {
                    await plugin.call("linear.comment", { issueId: issue.id, body: comment });
                    setComment("");
                  });
                }
              }}
            />
            <div className="flex justify-end">
              <Button
                disabled={!!busy || !comment.trim()}
                onClick={() =>
                  run("comment", async () => {
                    await plugin.call("linear.comment", { issueId: issue.id, body: comment });
                    setComment("");
                  })
                }
              >
                {busy === "comment" ? "Commenting…" : "Comment"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
