// The web app's plugins, and which of them a device has.

import type { DeviceFeature, DeviceInfo, TabKind } from "@everywhere/protocol";
import { agent } from "./builtin/agent";
import { browser } from "./builtin/browser";
import { dashboards } from "./builtin/dashboards";
import { desktop } from "./builtin/desktop";
import { files } from "./builtin/files";
import { git } from "./builtin/git";
import { installed } from "./builtin/installed";
import { processes } from "./builtin/processes";
import { scratch } from "./builtin/scratch";
import { done, github, push, share } from "./builtin/small";
import { telemetry } from "./builtin/telemetry";
import { terminal } from "./builtin/terminal";
import { webTabs } from "./builtin/web-tabs";
import type { SettingsSection, TabKindDef, ToolRenderer, WebPlugin } from "./types";

/** Built-in plugins, in the order their tabs appear in menus. */
export const BUILTIN: readonly WebPlugin[] = [
  terminal,
  agent,
  browser,
  files,
  desktop,
  processes,
  dashboards,
  telemetry,
  webTabs,
  scratch,
  git,
  share,
  done,
  github,
  push,
  installed,
];

/** Whether the device has the plugins p needs. */
export function pluginAvailable(p: WebPlugin, info: DeviceInfo | undefined): boolean {
  const need = p.requires;
  if (!need) return true;
  if (!info) return false;
  // Daemons from before plugins say what they do with features only; newer
  // ones still report them (e.g. "desktop" only where it can work).
  const features = info.features ?? [];
  if (!(need.features ?? []).every((f) => features.includes(f))) return false;
  if (!info.plugins) return true;
  const ids = new Set(info.plugins.map((d) => d.id));
  return (need.plugins ?? []).every((id) => ids.has(id));
}

/** Whether the device runs a plugin, by its daemon id (or, for older daemons, the feature standing for it). */
export function deviceHasPlugin(info: DeviceInfo | undefined, id: string, feature?: DeviceFeature): boolean {
  if (!info) return false;
  if (info.plugins) return info.plugins.some((p) => p.id === id);
  return feature ? (info.features ?? []).includes(feature) : false;
}

/** The plugins available on a device. */
export function devicePlugins(info: DeviceInfo | undefined, extra: readonly WebPlugin[] = []): WebPlugin[] {
  return [...BUILTIN, ...extra].filter((p) => pluginAvailable(p, info));
}

/** Every tab kind the given plugins provide. */
export function tabKinds(plugins: readonly WebPlugin[]): TabKindDef[] {
  return plugins.flatMap((p) => p.tabs ?? []);
}

/** A tab kind's definition among all built-ins, available or not (to draw a tab whose plugin went away). */
export function builtinTabKind(kind: TabKind): TabKindDef | undefined {
  return tabKinds(BUILTIN).find((k) => k.kind === kind);
}

let tools: ToolRenderer[] | undefined;

/** How plugins draw a tool in the timeline, if one does. */
export function toolRenderer(name: string): ToolRenderer | undefined {
  tools ??= BUILTIN.flatMap((p) => p.timeline?.tools ?? []);
  return tools.find((t) => t.match.test(name));
}

/** Settings pages plugins contribute, in order. */
export function pluginSettings(): SettingsSection[] {
  return BUILTIN.flatMap((p) => p.settings ?? []).sort((a, b) => a.order - b.order);
}
