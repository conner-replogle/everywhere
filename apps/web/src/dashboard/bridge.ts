import type { Process, TelemetryQuery } from "@everywhere/protocol";

/*
 * What the app and a dashboard's frame say to each other over postMessage.
 * The frame (dashboard.html) is sandboxed with an opaque origin and no
 * network, so everything a dashboard sees comes through here: the app reads
 * it from the device and passes it on.
 */

/** The theme's variables, which the frame sets on its <html>. */
export interface FrameTheme {
  vars: Record<string, string>;
  dark: boolean;
}

/** The CSS variables a dashboard gets: theme.ts sets them on the app's <html>. */
export const THEME_VARS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--ring",
  "--live",
  "--warn",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
] as const;

/** A plugin's web part: which plugin, in which tab. */
export interface PluginFrameInfo {
  id: string;
  /** A tab of one of its kinds, or its settings page. */
  view: "tab" | "settings";
  pane: { id: string; kind: string; name: string };
  threadId: string;
  tabState?: string;
}

export type FrameRequest =
  | { method: "file"; params: { path: string } }
  /** Plugins: one of the plugin's own methods. */
  | { method: "plugin.call"; params: { method: string; params?: unknown } }
  | { method: "plugin.setTabState"; params: { state: string } }
  | { method: "plugin.openUrl"; params: { url: string } }
  /** Plugins: a data channel to the plugin's process; the reply is a MessagePort. */
  | { method: "plugin.channel"; params: { name: string; ordered?: boolean } }
  /** Plugins: its own key/value state (the app fixes which plugin's). */
  | { method: "plugin.kv"; params: { method: string; scope?: string; key?: string; value?: unknown; prefix?: string } }
  /** Plugins: its settings, as the browser may see them, and saving them. */
  | { method: "plugin.settings"; params: Record<string, never> }
  | { method: "plugin.setSettings"; params: { values: Record<string, unknown> } }
  | { method: "log"; params: { tail?: number; grep?: string } }
  | { method: "setState"; params: { key: string; value: unknown } }
  | { method: "query"; params: { query: TelemetryQuery } }
  | { method: "catalog"; params: { experiment?: string } }
  | { method: "events"; params: { experiment?: string; runs?: string[]; kind?: string; limit?: number } };

export interface FileReply {
  bytes: ArrayBuffer;
  type: string;
  size: number;
  modTime: number;
}

/** From the app to the frame. */
export type ToFrame =
  | { t: "init"; js: string; css?: string; process: Process; theme: FrameTheme }
  /** A plugin's web part instead of a dashboard. */
  | { t: "plugin-init"; js: string; css?: string; plugin: PluginFrameInfo; theme: FrameTheme }
  /** One of the plugin's events from the device. */
  | { t: "plugin-event"; event: unknown }
  | { t: "process"; process: Process }
  | { t: "theme"; theme: FrameTheme }
  /** The project's telemetry got new data: by experiment, the metrics that did. */
  | { t: "telemetry"; experiments: Record<string, string[]> }
  | { t: "reply"; id: number; result?: unknown; error?: string };

/** From the frame to the app. */
export type FromFrame =
  | { t: "ready" }
  | ({ t: "request"; id: number } & FrameRequest)
  /** Something went wrong in the dashboard: the model hears about it. */
  | { t: "error"; message: string };
