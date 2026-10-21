// The web app's plugin API: what a plugin contributes to the app (tab kinds,
// thread header items, composer slots, timeline tool renderers, settings
// pages) and the context its views get. Built-in plugins are modules in
// this folder; external plugins (installed on a device) run in a sandboxed
// frame through ./external. See PLUGINS.md.

import type { DeviceFeature, DeviceInfo, Process, Project, Tab, TabKind, Thread, Workdir } from "@everywhere/protocol";
import type { LucideIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import type { DeviceContextValue } from "@/components/device-context";
import type { ComposerDraft } from "@/lib/composer-inbox";
import type { DevicePeer } from "@/lib/peer";

/** A tab that only this browser knows of (a web page opened from a link). */
export interface LocalTab {
  id: string;
  kind: string;
  name: string;
  parentId: string;
  /** Plugin-specific data, e.g. a web tab's URL. */
  data?: unknown;
  tabState?: undefined;
}

/** The thread itself, one of its tabs, or a local tab: what a pane shows. */
export type Pane = (Thread & { parentId?: undefined; tabState?: undefined }) | Tab | LocalTab;

export function isLocal(p: Pane): p is LocalTab {
  return "data" in p || !("projectId" in p);
}

/** Events plugins send each other within a thread page. */
export interface ThreadEvents {
  /**
   * Tool calls in a claude pane's newest events (not history being
   * replayed), oldest first. recent: called in the last 30 s.
   */
  "agent.toolUses": { paneId: string; uses: { name: string; input: unknown; at: number; recent: boolean }[] };
  /** Ask the processes tab to show a process. */
  "processes.show": { id: string };
  /** Something for a desktop tab to show. */
  "desktop.show": { tabId: string; source: unknown };
}
export type ThreadEvent = keyof ThreadEvents;

export interface PromptOptions {
  title: string;
  label?: string;
  placeholder?: string;
  submitLabel?: string;
  initial?: string;
}

export interface OpenTabOptions {
  /** Show it (default) or just open it. */
  focus?: boolean;
  name?: string;
  /** A terminal tab's input, typed in but not run. */
  input?: string;
  /** Its initial tab state. */
  state?: string;
}

/** What a thread page gives its plugins. */
export interface ThreadContext {
  deviceId: string;
  threadId: string;
  thread: Thread;
  project?: Project;
  /** The device's Scratch project, if it has one. */
  scratchProject?: Project;
  entry: DeviceContextValue;
  peer: DevicePeer;
  /** Bumps on every reconnection; channels from older ones are dead. */
  generation: number;
  info?: DeviceInfo;
  deviceName: string;
  workdir?: Workdir;
  /** Where the thread works: its worktree, Scratch folder or project. */
  cwd?: string;
  inScratch: boolean;
  archived: boolean;
  /** The device has tabs and the thread isn't archived. */
  canTab: boolean;
  tabs: Tab[];
  hasPlugin(id: string): boolean;
  hasFeature(f: DeviceFeature): boolean;
  /** Keeps the thread's tab (it stops being the preview tab). */
  keep(): void;
  /** Shows a pane, beside the one you're working in if split. */
  setActive(id: string): void;
  /** Opens a tab of a kind; a single kind's existing tab is shown instead. */
  openTab(kind: TabKind, opts?: OpenTabOptions): Promise<Tab | undefined>;
  /** Whether the user closed a tab of kind in the last ms (don't reopen it on them). */
  closedRecently(kind: TabKind, ms: number): boolean;
  /** Opens a link as a web tab in this browser. */
  openUrl(url: string): void;
  /** Hands a draft to the thread's claude composer (the thread's, or the last claude tab opened); false if none. */
  sendToClaude?: (draft: ComposerDraft) => boolean;
  /** Asks the user for a line of text. */
  prompt(o: PromptOptions): Promise<string | null>;
  error: string | null;
  setError(e: string | null): void;
  /** Restores an archived thread. */
  restore(): Promise<void>;
  emit<E extends ThreadEvent>(event: E, payload: ThreadEvents[E]): void;
  on<E extends ThreadEvent>(event: E, fn: (payload: ThreadEvents[E]) => void): () => void;
}

/** What a tab's view gets. */
export interface PaneContext extends ThreadContext {
  pane: Pane;
  /** Shown in either side of a split. */
  shown: boolean;
  /** Saves the view's state (tabs.setState), for when it opens again. */
  setTabState(state: string): void;
  /** Contributions other plugins make to this view's slots. */
  slot(name: SlotName): ReactNode;
  /** The plugins available here, for collecting what they add to this view (timeline filters, views). */
  plugins: readonly WebPlugin[];
  /** Reports something for the header's status (see TabKindDef.status). */
  report(value: unknown): void;
}

export type SlotName = "composer.above";

export interface TabKindDef {
  kind: TabKind;
  /** Its name in menus, and the thread's own tab's label. */
  title: string;
  icon: LucideIcon;
  /** A thread has at most one (the daemon's manifest can say so too). */
  single?: boolean;
  /** Which input in it keeps the thread's tab: keys only (a terminal), or pointer too. */
  capture?: "keys" | "all";
  /** Unmounted when not shown, rather than kept (the browser streams only while shown). */
  unmountHidden?: boolean;
  /** Offered in the new-tab menu (default: yes, if the device has the plugin). */
  menu?: boolean;
  /** A local tab kind: lives in this browser only. */
  local?: boolean;
  /** More tabs.create params for a new tab (e.g. a claude tab's permission mode). */
  createParams?: () => Promise<Record<string, unknown>>;
  /** Opens one from the new-tab menu, instead of tabs.create. */
  create?: (ctx: ThreadContext) => void | Promise<void>;
  /** Asks before closing a tab of this kind; null to close at once. */
  confirmClose?: (pane: Pane) => { title: string; description: string; confirmLabel: string } | null;
  render(ctx: PaneContext): ReactNode;
  /** The header's status for this pane, from what it reported. */
  status?: (pane: Pane, reported: unknown) => ReactNode;
  /** A count on its tab (e.g. running processes). */
  badge?: (pane: Pane, thread: Thread) => number | undefined;
}

export interface LocalTabsDef {
  /** A hook listing this browser's tabs of a thread. */
  use(deviceId: string, threadId: string): LocalTab[];
  close(deviceId: string, threadId: string, id: string): void;
  rename(deviceId: string, threadId: string, id: string, name: string): void;
}

export interface ToolRenderer {
  match: RegExp;
  icon?: LucideIcon;
  label?: (name: string) => string;
  /** The one-line summary; undefined falls back to the default (the first string argument). */
  summary?: (input: Record<string, unknown>, name: string) => string | undefined;
}

export interface SettingsSection {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Lower comes first. */
  order: number;
}

export interface WebPlugin {
  id: string;
  title: string;
  /**
   * The device plugins it needs. Devices that list plugins (feature
   * "plugins") are checked against them; older ones against features.
   */
  requires?: { plugins?: string[]; features?: DeviceFeature[] };
  tabs?: TabKindDef[];
  localTabs?: LocalTabsDef;
  /** Items in a thread's header (after its tabs' title). */
  threadHeader?: ComponentType<{ ctx: ThreadContext }>[];
  slots?: Partial<Record<SlotName, (ctx: PaneContext) => ReactNode>>;
  timeline?: { tools?: ToolRenderer[]; filters?: TimelineFilter[] };
  settings?: SettingsSection[];
  /** On a device's page, and in its menu in the sidebar. */
  device?: { header?: ComponentType<DeviceProps>[]; menu?: ComponentType<DeviceProps>[]; sections?: DeviceSection[] };
  sidebar?: {
    /** Above Projects (Scratch). */
    sections?: SidebarSection[];
    /** On a thread's row (running processes). */
    threadBadges?: ComponentType<{ thread: Thread; deviceId?: string }>[];
  };
  /** Views it adds to other plugins' slots. */
  views?: { [S in keyof ViewSlots]?: ViewDef<ViewSlots[S]>[] };
  on?: { [E in ThreadEvent]?: (payload: ThreadEvents[E], ctx: ThreadContext) => void };
}

/** What device-level contributions get. */
export interface DeviceProps {
  entry: DeviceContextValue;
}

/** A section of a device's page (below its header, before Home and Projects). */
export interface DeviceSection {
  order: number;
  component: ComponentType<DeviceProps>;
}

/**
 * What a sidebar section gets: every device, and the sidebar's own ways of
 * drawing and tucking threads, so a section looks like the rest.
 */
export interface SidebarSectionProps {
  entries: DeviceContextValue[];
  /** Collapsed rows and sections, by key; toggle flips one. */
  collapsed: Set<string>;
  toggle(key: string): void;
  isActive(entry: DeviceContextValue, t: Thread): boolean;
  /** A thread row as the sidebar draws it. */
  threadRow(entry: DeviceContextValue, t: Thread, opts?: { idle?: boolean }): ReactNode;
  /** Splits threads into listed, done and idle (idle after idleAfterMs). */
  split(entry: DeviceContextValue, threads: Thread[], idleAfterMs: number): { listed: Thread[]; done: Thread[]; idle: Thread[] };
  /** The "N done" and "N idle" rows for a group's tucked threads. */
  tucked(key: string, entry: DeviceContextValue, part: { done: Thread[]; idle: Thread[] }, idleDays: number): ReactNode;
  /** Menu items for a new thread of each kind the device has. */
  newThreadItems(entry: DeviceContextValue, onPick: (kind: Thread["kind"]) => void): ReactNode;
  onError(message: string | null): void;
}

export interface SidebarSection {
  order: number;
  component: ComponentType<SidebarSectionProps>;
}

/** A filter of a claude thread's timeline ("Changes to this computer"). */
export interface TimelineFilter {
  id: string;
  label: string;
  title?: string;
  /** Offered in this pane? */
  when?: (ctx: PaneContext) => boolean;
  /** The items it shows, from the whole timeline (see components/agent/timeline). */
  apply(items: unknown[], cwd: string | undefined): unknown[];
}

/**
 * Views a plugin adds inside another plugin's view, by slot. A host
 * plugin names a slot and what its views get; others fill it.
 */
export interface ViewSlots {
  /** The processes tab's views of the selected process (Dashboard, Charts, Log). */
  "process.view": ProcessViewProps;
}

export interface ProcessViewProps {
  peer: DevicePeer;
  threadId: string;
  generation: number;
  process: Process;
  /** By the Charts view: other runs it compares, and changing them. */
  compare: string[];
  onCompare(runs: string[]): void;
}

export interface ViewDef<P> {
  id: string;
  label: string;
  /** Where its button goes among the slot's (lower first). */
  order: number;
  /** Offered for these props? */
  when(props: P): boolean;
  /** Picked by default in this order (lower first), unless the user picked one. */
  rank(props: P): number;
  /** Stays mounted (hidden) when another view is shown, so switching back is instant. */
  keepMounted?: boolean;
  render(props: P): ReactNode;
}

/** The views every plugin here adds to a slot. */
export function slotViews<S extends keyof ViewSlots>(plugins: readonly WebPlugin[], slot: S): ViewDef<ViewSlots[S]>[] {
  return plugins.flatMap((p) => (p.views?.[slot] ?? []) as ViewDef<ViewSlots[S]>[]).sort((a, b) => a.order - b.order);
}

export function definePlugin(p: WebPlugin): WebPlugin {
  return p;
}
