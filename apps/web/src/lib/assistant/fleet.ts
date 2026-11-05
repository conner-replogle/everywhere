// What the assistant knows about the devices: the fleet the app already
// keeps (FleetProvider), mirrored here so the agent's tools can reach it
// outside React, plus finding devices and threads by what the user calls them.

import type { Project, Thread } from "@everywhere/protocol";
import type { DeviceContextValue } from "@/components/device-context";
import type { DevicePeer } from "@/lib/peer";

let entries: ReadonlyMap<string, DeviceContextValue> = new Map();
let deviceNames = new Map<string, string>();

/** Called by the assistant's bridge under FleetProvider. */
export function setFleet(next: ReadonlyMap<string, DeviceContextValue>, names: Map<string, string>): void {
  entries = next;
  deviceNames = names;
}

export interface FleetDevice {
  id: string;
  name: string;
  online: boolean;
  peer: DevicePeer | null;
  projects: Project[];
  threads: Thread[];
}

export function fleetDevices(): FleetDevice[] {
  const out: FleetDevice[] = [];
  for (const [id, name] of deviceNames) {
    const e = entries.get(id);
    const online = e?.conn.state === "connected";
    out.push({
      id,
      name,
      online,
      peer: online ? (e?.peer ?? null) : null,
      projects: e?.projects.data ?? [],
      threads: e?.threads.data ?? [],
    });
  }
  return out;
}

const norm = (s: string) => s.trim().toLowerCase();

/** A device by id or name (case-insensitive). */
export function findDevice(ref: string): FleetDevice {
  const all = fleetDevices();
  const d = all.find((x) => x.id === ref) ?? all.find((x) => norm(x.name) === norm(ref));
  if (!d) throw new Error(`No device "${ref}". Devices: ${all.map((x) => x.name).join(", ") || "none"}.`);
  return d;
}

export function onlineDevice(ref: string): FleetDevice & { peer: DevicePeer } {
  const d = findDevice(ref);
  if (!d.online || !d.peer) throw new Error(`${d.name} is offline, so its threads can't be reached right now.`);
  return d as FleetDevice & { peer: DevicePeer };
}

/**
 * A thread by id, or by name (exact, then contained), on one device or on
 * any. Ambiguous names are an error that lists the candidates.
 */
export function findThread(threadRef: string, deviceRef?: string): { device: FleetDevice; thread: Thread } {
  const devices = deviceRef ? [findDevice(deviceRef)] : fleetDevices();
  const all = devices.flatMap((device) => device.threads.map((thread) => ({ device, thread })));
  const byId = all.find((x) => x.thread.id === threadRef);
  if (byId) return byId;
  const q = norm(threadRef);
  const exact = all.filter((x) => norm(x.thread.name) === q);
  const matches = exact.length ? exact : all.filter((x) => norm(x.thread.name).includes(q));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    const where = deviceRef ? ` on ${devices[0]?.name}` : "";
    throw new Error(`No thread called "${threadRef}"${where}. Use list_threads to see them.`);
  }
  throw new Error(
    `"${threadRef}" matches ${matches.length} threads: ${matches
      .slice(0, 8)
      .map((x) => `${x.thread.name} (${x.thread.id} on ${x.device.name})`)
      .join("; ")}. Pass the thread's id.`,
  );
}

export function findProject(projectRef: string, deviceRef: string): { device: FleetDevice; project: Project } {
  const device = findDevice(deviceRef);
  const q = norm(projectRef);
  const project =
    device.projects.find((p) => p.id === projectRef) ??
    device.projects.find((p) => norm(p.name) === q) ??
    device.projects.find((p) => norm(p.path).endsWith(`/${q}`));
  if (!project) {
    throw new Error(`No project "${projectRef}" on ${device.name}. Projects: ${device.projects.map((p) => p.name).join(", ")}.`);
  }
  return { device, project };
}

export function projectName(device: FleetDevice, projectId: string): string {
  const p = device.projects.find((x) => x.id === projectId);
  if (!p) return "?";
  return p.isScratch ? "Scratch" : p.isHome ? "home" : p.name;
}

export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function threadStatus(t: Thread): string {
  if (t.archivedAt) return "archived";
  if (t.kind === "claude" || t.agentStatus) {
    const s = t.agentStatus ?? "stopped";
    if (t.doneAt && s !== "working" && s !== "waiting") return "done";
    return s === "stopped" || s === "idle" ? "idle" : s;
  }
  return t.running ? "running" : "closed";
}

export function threadLine(device: FleetDevice, t: Thread, now = Date.now()): string {
  const bits = [`${t.kind}`, threadStatus(t), `last active ${ago(t.lastOpenedAt ?? t.createdAt, now)}`];
  if (t.processes) bits.push(`${t.processes} process${t.processes === 1 ? "" : "es"} running`);
  return `- "${t.name}" [id ${t.id}] in ${projectName(device, t.projectId)} on ${device.name}: ${bits.join(", ")}`;
}

const RECENT_MS = 3 * 86_400_000;

/**
 * Every device, its projects, and the threads that are working, waiting on
 * the user, or touched in the last three days: what the assistant always
 * knows without calling a tool.
 */
export function fleetOverview(now = Date.now()): string {
  const lines: string[] = [];
  for (const d of fleetDevices()) {
    if (!d.online) {
      lines.push(`## ${d.name} (offline)`);
      continue;
    }
    const projects = d.projects.filter((p) => !p.isHome && !p.isScratch).map((p) => `${p.name} (${p.path})`);
    lines.push(`## ${d.name} (online)`, `Projects: ${projects.join(", ") || "none"}`);
    const recent = d.threads
      .filter((t) => !t.archivedAt)
      .filter((t) => {
        const s = threadStatus(t);
        return s === "working" || s === "waiting" || s === "error" || now - (t.lastOpenedAt ?? t.createdAt) < RECENT_MS;
      })
      .sort((a, b) => (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt))
      .slice(0, 25);
    lines.push(recent.length ? recent.map((t) => threadLine(d, t, now)).join("\n") : "No recent threads.");
  }
  return lines.join("\n") || "No devices are enrolled.";
}

/** Where the user is in the app, from the URL, in words. */
export function describeView(pathname: string, search: string): string {
  const m = /^\/d\/([^/]+)(?:\/t\/([^/]+))?(\/desktop)?/.exec(pathname);
  if (!m) return pathname.startsWith("/settings") ? "the settings page" : "the home page";
  const deviceId = decodeURIComponent(m[1]!);
  const device = fleetDevices().find((d) => d.id === deviceId);
  const deviceName = device?.name ?? deviceId;
  if (m[3]) return `the remote desktop of ${deviceName}`;
  if (!m[2]) return `the page of device ${deviceName}`;
  const threadId = decodeURIComponent(m[2]);
  const t = device?.threads.find((x) => x.id === threadId);
  if (!t || !device) return `a thread (id ${threadId}) on ${deviceName}`;
  const tab = new URLSearchParams(search).get("tab");
  return `the thread "${t.name}" [id ${t.id}] in ${projectName(device, t.projectId)} on ${deviceName} (${threadStatus(t)})${tab ? ", with one of its tabs open" : ""}`;
}
