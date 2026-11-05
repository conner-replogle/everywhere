// A bug report: what the app, its connections and its devices were doing
// when something went wrong, in one JSON file. Collected when the user asks
// (the bug button), from this tab and over its own device connections.

import type { AgentEvent } from "@everywhere/protocol";
import type { DeviceContextValue } from "@/components/device-context";
import type { Device } from "@/lib/api";
import { readAgent } from "./agent-read";
import { assistantSync } from "./assistant/sync";
import { micInputs } from "./assistant/mic";
import { screenCards } from "./assistant/screen";
import { consoleEntries } from "./console-log";
import { desktop } from "./desktop";
import { hub } from "./hub";
import { sampleStats } from "./webrtc-stats";

const CALL_TIMEOUT_MS = 6000;
/** The open thread's newest events, and how much of each is kept. */
const THREAD_EVENTS = 200;
const EVENT_TEXT = 3000;
const DEVICE_LOG_LINES = 1000;

export interface BugReportOptions {
  note: string;
  /** Include the open thread's recent messages (they can hold anything). */
  threadMessages: boolean;
  /** A PNG data URL of the page. */
  screenshot?: string;
}

/** Settles with the value, or with what went wrong, within the timeout. */
async function attempt<T>(fn: () => Promise<T> | T): Promise<T | { error: string }> {
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), CALL_TIMEOUT_MS)),
    ]);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function clipEvent(e: AgentEvent): unknown {
  const clip = (s: string) => (s.length > EVENT_TEXT ? `${s.slice(0, EVENT_TEXT)}… (${s.length} chars)` : s);
  const x = { ...e } as Record<string, unknown>;
  for (const k of ["text", "output"]) if (typeof x[k] === "string") x[k] = clip(x[k] as string);
  if (x.input !== undefined) x.input = clip(JSON.stringify(x.input));
  return x;
}

/** The device and thread the page shows, from its URL. */
function where(): { deviceId?: string; threadId?: string } {
  const m = /^\/d\/([^/]+)(?:\/t\/([^/]+))?/.exec(location.pathname);
  return m ? { deviceId: decodeURIComponent(m[1]!), threadId: m[2] ? decodeURIComponent(m[2]) : undefined } : {};
}

async function deviceReport(device: Device, e: DeviceContextValue | undefined) {
  const peer = e?.peer;
  const connected = e?.conn.state === "connected" && !!peer;
  const pc = peer?.peerConnection;
  return {
    id: device.id,
    name: device.name,
    os: device.os,
    arch: device.arch,
    version: device.version,
    lastSeenAt: device.lastSeenAt,
    online: hub.isOnline(device.id),
    connection: e ? { state: e.conn.state, error: e.conn.error, generation: e.conn.generation } : null,
    info: e?.info.data ?? e?.info.error ?? null,
    peer: peer ? { ...peer.debugInfo(), log: peer.debugLog() } : null,
    stats: pc ? await attempt(() => sampleStats(pc)) : null,
    daemonPeer: connected ? await attempt(() => peer.call("debug.peer", {}, CALL_TIMEOUT_MS)) : null,
    daemonLog: connected ? await attempt(() => peer.call("debug.logs", { lines: DEVICE_LOG_LINES }, CALL_TIMEOUT_MS)) : null,
    projects: e?.projects.data?.map((p) => ({ id: p.id, name: p.name, isHome: p.isHome, isScratch: p.isScratch })) ?? e?.projects.error ?? null,
    threads:
      e?.threads.data?.map((t) => ({
        id: t.id,
        name: t.name,
        kind: t.kind,
        projectId: t.projectId,
        agentStatus: t.agentStatus,
        running: t.running,
        processes: t.processes,
        doneAt: t.doneAt,
        archivedAt: t.archivedAt,
        lastOpenedAt: t.lastOpenedAt,
      })) ??
      e?.threads.error ??
      null,
  };
}

async function threadReport(entries: ReadonlyMap<string, DeviceContextValue>, withMessages: boolean) {
  const { deviceId, threadId } = where();
  if (!deviceId || !threadId) return null;
  const e = entries.get(deviceId);
  const thread = e?.threads.data?.find((t) => t.id === threadId) ?? null;
  const out: Record<string, unknown> = { deviceId, threadId, tab: new URLSearchParams(location.search).get("tab"), thread };
  if (e?.conn.state !== "connected" || !thread || thread.kind === "terminal") return out;
  const read = await attempt(() => readAgent(e.peer, threadId, withMessages ? THREAD_EVENTS : 1));
  if ("error" in read) out.agent = read;
  else {
    out.agentState = read.state;
    if (withMessages) out.events = read.events.map(clipEvent);
  }
  out.processes = await attempt(() => e.peer.call("processes.list", { threadId }, CALL_TIMEOUT_MS));
  return out;
}

async function assistantReport() {
  const s = assistantSync.getSnapshot();
  const extra = await attempt(async () => {
    const [{ assistantRunner, modelId }, { voice }] = await Promise.all([import("./assistant/agent"), import("./assistant/voice")]);
    // turn: this tab's agent (runner, above, is the connection running a turn).
    return { model: modelId(), turn: assistantRunner.getSnapshot(), voice: { ...voice.getSnapshot(), ...voice.debug() } };
  });
  return {
    status: s.status,
    synced: s.synced,
    me: s.me,
    runner: s.runner,
    entries: s.entries.length,
    lastSeq: s.entries.at(-1)?.seq ?? null,
    live: s.live ? { activity: s.live.activity, textChars: s.live.text.length } : null,
    // What's on screen: ids and sizes, not the cards' content.
    screen: screenCards(s.entries).map((c) => ({ id: c.id, chars: c.markdown.length, seq: c.seq })),
    writing: s.live?.cards?.map((c) => c.id) ?? [],
    feedHidden: localStorage.getItem("ew.assistant.feedHidden") === "1",
    ...extra,
  };
}

export async function collectBugReport(
  devices: Device[] | undefined,
  entries: ReadonlyMap<string, DeviceContextValue>,
  opts: BugReportOptions,
): Promise<Record<string, unknown>> {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src ?? null;
  const [deviceReports, thread, assistant] = await Promise.all([
    Promise.all((devices ?? []).map((d) => deviceReport(d, entries.get(d.id)))),
    threadReport(entries, opts.threadMessages),
    assistantReport(),
  ]);
  return {
    report: "everywhere bug report",
    version: 1,
    at: new Date().toISOString(),
    note: opts.note,
    page: {
      url: location.href,
      title: document.title,
      build: script ? new URL(script).pathname : null,
      desktopApp: desktop?.version ?? null,
      userAgent: navigator.userAgent,
      language: navigator.language,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      standalone: matchMedia("(display-mode: standalone)").matches,
      online: navigator.onLine,
      visibility: document.visibilityState,
      uptimeMs: Math.round(performance.now()),
    },
    hub: { ...hub.getSnapshot(), online: [...hub.getSnapshot().online] },
    // The microphones there are (labels are empty until the page has had mic access).
    mics: await attempt(async () =>
      (await micInputs()).map((d) => ({ label: d.label, id: d.deviceId.slice(0, 12), group: d.groupId.slice(0, 12) })),
    ),
    devices: deviceReports,
    thread,
    assistant,
    console: consoleEntries(),
    screenshot: opts.screenshot ?? null,
  };
}

/** One frame of this tab, after the user picks it in the browser's share prompt. */
export async function captureScreenshot(): Promise<string> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser" },
    audio: false,
    preferCurrentTab: true,
  } as DisplayMediaStreamOptions);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    // Let a frame without the share prompt's own UI come through.
    await new Promise((r) => setTimeout(r, 300));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    return canvas.toDataURL("image/png");
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}
