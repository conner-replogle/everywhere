import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { Tab, TabKind } from "@everywhere/protocol";
import { ArrowLeftRightIcon, Columns2Icon, PlusIcon, PuzzleIcon, XIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { CenteredMessage } from "@/components/centered-message";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { OpenLinkContext, RunInTerminalContext } from "@/components/agent/markdown";
import { useDevice } from "@/components/device-context";
import { RenameDialog } from "@/components/rename-dialog";
import { SplitArea } from "@/components/split-area";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sendToComposer } from "@/lib/composer-inbox";
import { hub } from "@/lib/hub";
import { useRpc } from "@/lib/peer";
import { touchThread } from "@/lib/idle-threads";
import { isInputKey, retainThread, visitThread } from "@/lib/recent-threads";
import { openWebTab } from "@/lib/web-tabs";
import { cn, errorMessage } from "@/lib/utils";
import { createThreadBus } from "@/plugins/bus";
import { useExternalPlugins } from "@/plugins/external";
import { agentViewKinds, isAgentKind } from "@/plugins/builtin/agent";
import { BUILTIN, builtinTabKind, devicePlugins, tabKinds } from "@/plugins/registry";
import {
  isLocal,
  type LocalTab,
  type OpenTabOptions,
  type Pane,
  type PaneContext,
  type PromptOptions,
  type SlotName,
  type TabKindDef,
  type ThreadContext,
} from "@/plugins/types";

export const Route = createFileRoute("/_app/_workspace/d/$deviceId/t/$threadId")({
  // tab: the pane shown (the thread itself if absent); split: one shown beside it.
  validateSearch: (search: Record<string, unknown>): { tab?: string; split?: string } => ({
    ...(typeof search.tab === "string" ? { tab: search.tab } : {}),
    ...(typeof search.split === "string" ? { split: search.split } : {}),
  }),
  component: ThreadPage,
});

/** A kind no plugin here provides: its tab still shows, saying why it can't. */
function unknownKind(kind: TabKind): TabKindDef {
  return {
    kind,
    title: kind,
    icon: PuzzleIcon,
    menu: false,
    render: () => (
      <CenteredMessage
        title="This tab's plugin isn't available"
        body={`Showing a "${kind}" tab needs a plugin this device or this version of the app doesn't have.`}
      />
    ),
  };
}

function ThreadPage() {
  const { deviceId, threadId } = Route.useParams();
  const { tab: tabParam, split: splitParam } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const entry = useDevice();
  const { device, peer, conn, threads, projects, info } = entry;
  const features = info.data?.features ?? [];
  const thread = threads.data?.find((t) => t.id === threadId);
  const project = thread && projects.data?.find((p) => p.id === thread.projectId);
  const scratch = projects.data?.find((p) => p.isScratch);
  const inScratch = !!project?.isScratch;
  const archived = !!thread?.archivedAt;
  const canTab = features.includes("tabs") && !archived;
  const tabs = useRpc(peer, "tabs.list", { threadId }, ["threads.changed"], canTab);
  const workdir = useRpc(peer, "threads.workdir", { id: threadId }, ["threads.changed"], canTab);

  // The plugins this device has: built-ins it runs, and external ones with a web part.
  const external = useExternalPlugins(entry);
  const plugins = useMemo(() => devicePlugins(info.data, external), [info.data, external]);
  // Built-ins' tab kinds, and other agents' (drawn with the agent view).
  const kinds = useMemo(() => [...tabKinds(plugins), ...agentViewKinds(info.data?.plugins)], [plugins, info.data?.plugins]);
  const kindOf = (kind: TabKind): TabKindDef => kinds.find((k) => k.kind === kind) ?? builtinTabKind(kind) ?? unknownKind(kind);
  // One tab per kind, except kinds that are several things by nature (web pages).
  const multipleKinds = new Set(kinds.filter((k) => k.multiple).map((k) => k.kind));

  // Daemons from before tabs still have their project's browser, as a fixed tab.
  const legacyBrowser = !!info.data && !features.includes("tabs") && !archived && !!thread;
  const legacyTab: Tab | undefined =
    legacyBrowser && thread
      ? { ...thread, id: `${thread.id}:browser`, kind: "browser", name: "Browser", parentId: thread.id }
      : undefined;
  // Tabs only this browser knows of (web pages), from plugins that keep them. Every
  // built-in's hook runs, in a fixed order, whether or not the device has it.
  const localByPlugin = BUILTIN.map((p) => (p.localTabs ? p.localTabs.use(deviceId, threadId) : []));
  const localPanes: LocalTab[] = archived ? [] : localByPlugin.flat();
  const localOwner = (t: LocalTab) => BUILTIN[localByPlugin.findIndex((l) => l.some((x) => x.id === t.id))];
  const panes: Pane[] = thread
    ? [thread, ...(canTab ? (tabs.data ?? []) : []), ...(legacyTab ? [legacyTab] : []), ...localPanes]
    : [];
  // A tab that's gone (closed elsewhere) falls back to the thread.
  const primary = panes.find((p) => p.id === tabParam) ?? thread;
  // Split view: a second pane beside (or, narrow, below) the first.
  const splitPane = splitParam && splitParam !== primary?.id ? panes.find((p) => p.id === splitParam) : undefined;
  // The pane you last touched: tab clicks go there.
  const [focusSide, setFocusSide] = useState<"primary" | "split">("primary");
  const side = splitPane ? focusSide : "primary";
  const active = side === "split" ? splitPane : primary;
  const show = (primaryId: string, splitId?: string) =>
    navigate({
      search: {
        ...(primaryId === threadId ? {} : { tab: primaryId }),
        ...(splitId && splitId !== primaryId ? { split: splitId } : {}),
      },
      replace: true,
      resetScroll: false,
    });
  /** A tab the user picked: into the focused pane, unless it's shown already. */
  const select = (id: string) => {
    if (id === primary?.id) return setFocusSide("primary");
    if (id === splitPane?.id) return setFocusSide("split");
    if (splitPane && side === "split") show(primary!.id, id);
    else show(id, splitPane?.id);
  };
  /**
   * A pane something opened (a link, a process, an annotation's claude
   * tab): shown, and with a split, beside the one you're working in rather
   * than in its place.
   */
  const setActive = (id: string) => {
    if (id === primary?.id) return setFocusSide("primary");
    if (id === splitPane?.id) return setFocusSide("split");
    if (splitPane && side === "primary") show(primary!.id, id);
    else if (splitPane) show(id, splitPane.id);
    else show(id);
  };
  const openSplit = (id: string) => {
    show(primary!.id, id);
    setFocusSide("split");
  };
  const closeSplit = () => {
    // The focused pane stays.
    show(active!.id);
    setFocusSide("primary");
  };

  // Panes stay mounted once opened, so switching tabs keeps a terminal's
  // scrollback and a claude draft; kinds that ask to are unmounted when hidden.
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const activeId = primary?.id;
  const splitId = splitPane?.id;
  // The thread's plugins talk to each other on its bus.
  const bus = useMemo(() => createThreadBus(), [threadId]);
  // Before the effect below, so a new thread starts empty and then opens.
  useEffect(() => {
    setOpened(new Set());
    setFocusSide("primary");
  }, [threadId]);
  // Opening a thread gives it a tab along the top (the preview tab, unless it
  // has one already), and counts as touching it, for the sidebar's idle threads.
  const threadName = thread?.name;
  const threadKind = thread?.kind;
  useEffect(() => {
    if (!threadName || !threadKind) return;
    visitThread(deviceId, threadId, { name: threadName, kind: threadKind });
    touchThread(deviceId, threadId);
  }, [deviceId, threadId, threadName, threadKind]);
  // Doing something in the thread keeps its tab, so opening another thread doesn't replace it.
  const keep = () => retainThread(deviceId, threadId);
  // No push notifications about the thread on screen.
  useEffect(() => {
    hub.setThread({ deviceId, threadId });
    return () => hub.setThread(null);
  }, [deviceId, threadId]);
  useEffect(() => {
    for (const id of [activeId, splitId]) {
      if (id) setOpened((s) => (s.has(id) ? s : new Set(s).add(id)));
    }
  }, [activeId, splitId]);

  // What panes report for the header's status (a terminal's writer role).
  const [reports, setReports] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Pane | null>(null);
  const [asking, setAsking] = useState<(PromptOptions & { resolve: (v: string | null) => void }) | null>(null);
  const [closing, setClosing] = useState<{ pane: Tab; title: string; description: string; confirmLabel: string } | null>(
    null,
  );
  const closedAt = useRef<Record<string, number>>({});
  const openingTab = useRef<Record<string, boolean>>({});

  const restore = async () => {
    setError(null);
    try {
      await peer.call("threads.archive", { id: threadId, archived: false });
      threads.refetch();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const openTab = async (kind: TabKind, opts: OpenTabOptions = {}): Promise<Tab | undefined> => {
    const focus = opts.focus ?? true;
    const single = !multipleKinds.has(kind) && !opts.another;
    // The thread is its own kind's tab (a Claude thread has its Claude).
    const existing = single && (thread?.kind === kind ? (thread as Tab) : tabs.data?.find((t) => t.kind === kind));
    if (existing) {
      if (focus) setActive(existing.id);
      return existing;
    }
    if (single && openingTab.current[kind]) return undefined;
    openingTab.current[kind] = true;
    setError(null);
    try {
      const extra = (await kindOf(kind).createParams?.()) ?? {};
      const t = await peer.call("tabs.create", {
        threadId,
        kind,
        ...extra,
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.input ? { input: opts.input } : {}),
      });
      if (opts.state) await peer.call("tabs.setState", { id: t.id, state: opts.state });
      tabs.refetch();
      if (focus) setActive(t.id);
      return t as Tab;
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      openingTab.current[kind] = false;
    }
  };

  // Opens a terminal tab with a command typed in (not run), e.g. one that needs sudo.
  const runInTerminal =
    canTab && features.includes("scratch")
      ? (command: string) => void openTab("terminal", { name: "Terminal", input: command, another: true })
      : null;

  // A shown tab closing: with a split, the other pane takes the view; else its neighbour.
  const leave = (t: Pane) => {
    if (t.id === splitPane?.id) {
      show(primary!.id);
      setFocusSide("primary");
      return;
    }
    if (t.id !== primary?.id) return;
    if (splitPane) {
      show(splitPane.id);
      setFocusSide("primary");
      return;
    }
    const i = panes.findIndex((p) => p.id === t.id);
    show((panes[i + 1] ?? panes[i - 1] ?? thread!).id);
  };

  const closeTab = async (t: Pane) => {
    if (isLocal(t)) {
      leave(t);
      localOwner(t)?.localTabs?.close(deviceId, threadId, t.id);
      return;
    }
    closedAt.current[t.kind] = Date.now();
    leave(t);
    await peer.call("tabs.close", { id: t.id });
    tabs.refetch();
  };

  // Links (a process's web UI, one in Claude's reply) open as a web tab here,
  // not in the device's browser: you're the one looking.
  const openUrl = (url: string) => {
    const t = openWebTab(deviceId, threadId, url);
    keep();
    setActive(t.id);
  };

  // Annotations go to the thread's claude, or else the last claude tab
  // opened here (only a mounted one has a composer to take them).
  const isAgent = (kind: string) => isAgentKind(kind, info.data?.plugins);
  const claudeTarget =
    thread && isAgent(thread.kind)
      ? thread.id
      : [...opened].reverse().find((id) => {
          const p = panes.find((p) => p.id === id);
          return !!p && isAgent(p.kind);
        });

  const ctx: ThreadContext | undefined = thread && {
    deviceId,
    threadId,
    thread,
    project,
    scratchProject: scratch,
    entry,
    peer,
    generation: conn.generation,
    info: info.data,
    deviceName: device.name || info.data?.hostname || "the device",
    workdir: workdir.data,
    cwd: workdir.data?.path ?? thread.scratchDir ?? project?.path,
    inScratch,
    archived,
    canTab,
    tabs: tabs.data ?? [],
    hasPlugin: (id) => plugins.some((p) => p.id === id),
    hasFeature: (f) => features.includes(f),
    keep,
    setActive,
    openTab,
    closedRecently: (kind, ms) => Date.now() - (closedAt.current[kind] ?? 0) < ms,
    openUrl,
    sendToClaude: claudeTarget
      ? (draft) => {
          if (!sendToComposer(claudeTarget, draft)) return false;
          keep();
          setActive(claudeTarget);
          return true;
        }
      : undefined,
    prompt: (o) => new Promise((resolve) => setAsking({ ...o, resolve })),
    error,
    setError,
    restore,
    emit: bus.emit,
    on: bus.on,
  };
  // Plugins' handlers get the page as it is when the event comes.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  useEffect(() => {
    const offs = plugins.flatMap((p) =>
      Object.entries(p.on ?? {}).map(([event, fn]) =>
        bus.on(event as never, (payload: never) => {
          const c = ctxRef.current;
          if (c) (fn as (payload: unknown, ctx: ThreadContext) => void)(payload, c);
        }),
      ),
    );
    return () => offs.forEach((off) => off());
  }, [bus, plugins]);

  const paneContext = (p: Pane): PaneContext => ({
    ...ctx!,
    pane: p,
    shown: p.id === primary?.id || p.id === splitPane?.id,
    setTabState: (state) => void peer.call("tabs.setState", { id: p.id, state }).catch(() => {}),
    slot: (name: SlotName) =>
      plugins.map((pl) => {
        const fn = pl.slots?.[name];
        return fn ? <Fragment key={pl.id}>{fn(paneContext(p))}</Fragment> : null;
      }),
    report: (value) => setReports((r) => (r[p.id] === value ? r : { ...r, [p.id]: value })),
    plugins,
  });

  // Input to a pane keeps the thread's tab. (Claude panes report sends
  // themselves: typing a draft isn't enough.)
  const inputCapture = (capture: "keys" | "all") => ({
    onKeyDownCapture: (e: React.KeyboardEvent) => isInputKey(e) && keep(),
    onPasteCapture: keep,
    onDropCapture: keep,
    // Phone keyboards type through input events, without telling keydown the key.
    onInputCapture: keep,
    ...(capture === "all" ? { onPointerDownCapture: keep } : {}),
  });

  if (threads.data && !thread) {
    return (
      <CenteredMessage title="Thread not found" body="It may have been deleted from another client.">
        <Button variant="outline" size="sm" asChild>
          <Link to="/">Back to projects</Link>
        </Button>
      </CenteredMessage>
    );
  }

  const activeKind = active && kindOf(active.kind);
  const newTabKinds = kinds.filter((k) => k.menu !== false && (k.local ? !archived : canTab));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {thread && (
        // The thread's bar: its tabs, then what plugins put in its header and its status.
        // On phones it leaves room for the sidebar's button.
        <div className="flex h-11 shrink-0 items-stretch border-b bg-sidebar pl-12 md:h-8 md:pl-0">
          <div
            role="tablist"
            aria-label="Tabs"
            className={cn("flex min-w-0 items-stretch overflow-x-auto", !(canTab || legacyBrowser) && "hidden")}
          >
            {panes.map((p) => {
              const local = isLocal(p);
              const closable = !!p.parentId && (canTab || local);
              return (
                <TabButton
                  key={p.id}
                  pane={p}
                  kind={kindOf(p.kind)}
                  active={p.id === active?.id}
                  shown={p.id === primary?.id || p.id === splitPane?.id}
                  split={!!splitPane}
                  badge={kindOf(p.kind).badge?.(p, thread)}
                  onSelect={() => select(p.id)}
                  onRename={closable ? () => (keep(), setRenaming(p)) : undefined}
                  onClose={
                    closable
                      ? () => {
                          keep();
                          const confirm = !local ? kindOf(p.kind).confirmClose?.(p) : null;
                          if (confirm && !local) setClosing({ pane: p as Tab, ...confirm });
                          else void closeTab(p).catch((e: unknown) => setError(errorMessage(e)));
                        }
                      : undefined
                  }
                />
              );
            })}
          </div>
          {(canTab || !archived) && newTabKinds.length > 0 && ctx && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="mx-1 self-center" aria-label="New tab" title="New tab">
                  <PlusIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {newTabKinds.map((k) => {
                  const Icon = k.icon;
                  return (
                    <DropdownMenuItem
                      key={k.kind}
                      onSelect={() => {
                        keep();
                        if (k.create) void k.create(ctx);
                        else void openTab(k.kind);
                      }}
                    >
                      <Icon />
                      {k.title}
                      {k.create ? "…" : ""}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2 pl-2">
          {error && !archived && (
            <span className="min-w-0 max-w-64 truncate text-xs text-destructive" title={error}>
              {error}
            </span>
          )}
          {ctx && plugins.flatMap((p) => (p.threadHeader ?? []).map((Item, i) => <Item key={`${p.id}:${i}`} ctx={ctx} />))}
          {archived ? (
            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Archived</span>
          ) : (
            active && activeKind?.status?.(active, reports[active.id])
          )}
          {panes.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn("mr-1 self-center", splitPane && "text-primary")}
                  aria-label="Split view"
                  title="Split view: two tabs at once"
                >
                  <Columns2Icon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                {panes
                  .filter((p) => p.id !== primary?.id && p.id !== splitPane?.id)
                  .map((p) => {
                    const k = kindOf(p.kind);
                    const Icon = k.icon;
                    return (
                      <DropdownMenuItem
                        key={p.id}
                        onSelect={() => (splitPane ? select(p.id) : openSplit(p.id))}
                      >
                        <Icon />
                        <span className="truncate">{p.parentId ? p.name : k.title}</span>
                        <span className="ml-auto pl-3 text-xs text-muted-foreground">{splitPane ? "here" : "beside"}</span>
                      </DropdownMenuItem>
                    );
                  })}
                {splitPane && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => (show(splitPane.id, primary!.id), setFocusSide(side === "split" ? "primary" : "split"))}>
                      <ArrowLeftRightIcon />
                      Swap sides
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={closeSplit}>
                      <XIcon />
                      Close split
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          </div>
        </div>
      )}
      <OpenLinkContext.Provider value={thread && !archived ? openUrl : null}>
      <RunInTerminalContext.Provider value={runInTerminal}>
      {/* Panes wait for the thread list, so a claude thread never flashes a terminal. */}
      <SplitArea
        split={!!splitPane}
        focused={side}
        onFocus={setFocusSide}
        items={
          ctx
            ? panes
                .filter(
                  (p) =>
                    p.id === primary?.id || p.id === splitPane?.id || (!kindOf(p.kind).unmountHidden && opened.has(p.id)),
                )
                .map((p) => {
                  const k = kindOf(p.kind);
                  return {
                    id: p.id,
                    side: p.id === primary?.id ? "primary" : p.id === splitPane?.id ? "split" : "hidden",
                    node: k.render(paneContext(p)),
                    props: { role: "tabpanel", ...(k.capture ? inputCapture(k.capture) : {}) },
                  };
                })
            : []
        }
      />
      </RunInTerminalContext.Provider>
      </OpenLinkContext.Provider>
      <RenameDialog
        open={!!renaming}
        onOpenChange={(o) => !o && setRenaming(null)}
        title="Rename tab"
        initial={renaming?.name ?? ""}
        onSubmit={async (name) => {
          if (renaming && isLocal(renaming)) {
            localOwner(renaming)?.localTabs?.rename(deviceId, threadId, renaming.id, name);
            return;
          }
          await peer.call("threads.rename", { id: renaming!.id, name });
          tabs.refetch();
        }}
      />
      <RenameDialog
        open={!!asking}
        onOpenChange={(o) => {
          if (!o && asking) {
            asking.resolve(null);
            setAsking(null);
          }
        }}
        title={asking?.title ?? ""}
        initial={asking?.initial ?? ""}
        label={asking?.label}
        placeholder={asking?.placeholder}
        submitLabel={asking?.submitLabel}
        onSubmit={async (value) => {
          asking?.resolve(value);
          setAsking(null);
        }}
      />
      <ConfirmDialog
        open={!!closing}
        onOpenChange={(o) => !o && setClosing(null)}
        title={closing?.title ?? ""}
        description={closing?.description ?? ""}
        confirmLabel={closing?.confirmLabel ?? "Close"}
        onConfirm={() => closeTab(closing!.pane)}
      />
    </div>
  );
}

function TabButton({
  pane: p,
  kind,
  active,
  shown,
  split,
  badge: running,
  onSelect,
  onRename,
  onClose,
}: {
  pane: Pane;
  kind: TabKindDef;
  /** In the focused pane. */
  active: boolean;
  /** In either pane. */
  shown: boolean;
  /** Two panes are shown. */
  split: boolean;
  /** A count on the tab (running processes…). */
  badge?: number;
  onSelect: () => void;
  onRename?: () => void;
  onClose?: () => void;
}) {
  const Icon = kind.icon;
  // The thread's own tab is named by its kind; the thread's name is above.
  const label = p.parentId ? p.name : kind.title;
  const status = !isLocal(p) ? p.agentStatus : undefined;
  return (
    <div
      className={cn(
        "group flex shrink-0 items-center border-r text-xs",
        shown ? "bg-background" : "hover:bg-accent/60",
        active ? "text-foreground" : "text-muted-foreground",
        // With a split, the focused pane's tab is marked as its pane is.
        split && active && "shadow-[inset_0_2px_0_var(--primary)]",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        onDoubleClick={onRename}
        onAuxClick={(e) => e.button === 1 && onClose?.()}
        title={onRename ? `${label} — double-click to rename` : label}
        className={cn("flex h-full max-w-48 items-center gap-1.5 pl-3 outline-none", onClose ? "pr-1" : "pr-3")}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
        {(status === "working" || status === "starting") && (
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-label="working" />
        )}
        {status === "waiting" && <span className="size-1.5 shrink-0 rounded-full bg-warn" aria-label="needs you" />}
        {!!running && (
          <span className="shrink-0 rounded-sm bg-live/15 px-1 text-[10px] text-live tabular-nums" aria-label={`${running} running`}>
            {running}
          </span>
        )}
      </button>
      {onClose && (
        <button
          type="button"
          aria-label={`Close ${label}`}
          onClick={onClose}
          className={cn(
            "mr-1 rounded-sm p-0.5 hover:bg-accent hover:text-foreground",
            !active && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100",
          )}
        >
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  );
}
