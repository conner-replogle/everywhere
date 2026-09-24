import type { CandidateInfo, PeerDebug } from "@everywhere/protocol";
import { BugIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { useDevice } from "@/components/device-context";
import { Button } from "@/components/ui/button";
import { forceRelay, type PeerDebugInfo, type PeerLogEntry, setForceRelay } from "@/lib/peer";
import { cn, errorMessage } from "@/lib/utils";
import {
  type CandidateStat,
  classifyPath,
  isTailscaleAddress,
  PATH_LABELS,
  type PathKind,
  type StatsSample,
  sampleStats,
} from "@/lib/webrtc-stats";

const STATS_INTERVAL_MS = 1000;
const DAEMON_INTERVAL_MS = 3000;
const OPEN_KEY = "ew:debug-device";

/** Which device the debug panel is open for, if any, remembered across reloads. */
export function useDebugPanelState(): [string | null, (deviceId: string | null) => void] {
  const [deviceId, setDeviceId] = useState(() => localStorage.getItem(OPEN_KEY));
  return [
    deviceId,
    (id: string | null) => {
      if (id) localStorage.setItem(OPEN_KEY, id);
      else localStorage.removeItem(OPEN_KEY);
      setDeviceId(id);
    },
  ];
}

// --- formatting ------------------------------------------------------------------------

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtRate(bytesPerSec: number): string {
  return `${fmtBytes(Math.round(bytesPerSec))}/s`;
}

function fmtBitrate(bps: number): string {
  if (bps < 1e6) return `${(bps / 1e3).toFixed(0)} kbps`;
  return `${(bps / 1e6).toFixed(1)} Mbps`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Browsers may omit their own host addresses entirely (mDNS masking). */
const HIDDEN = "(hidden)";

function hostPort(c: { address: string; port: number | null }): string {
  const host = !c.address ? HIDDEN : c.address.includes(":") ? `[${c.address}]` : c.address;
  return c.port === null ? host : `${host}:${c.port}`;
}

// --- data --------------------------------------------------------------------------------

interface Throughput {
  sent: number;
  received: number;
}

interface DaemonView {
  data: PeerDebug | null;
  error: string | null;
  unsupported: boolean;
  at: number | null;
}

function useDebugData() {
  const { peer, conn } = useDevice();
  const [local, setLocal] = useState<PeerDebugInfo>(() => peer.debugInfo());
  const [log, setLog] = useState<readonly PeerLogEntry[]>(() => peer.debugLog());
  const [stats, setStats] = useState<StatsSample | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [throughput, setThroughput] = useState<Throughput | null>(null);
  const [daemon, setDaemon] = useState<DaemonView>({ data: null, error: null, unsupported: false, at: null });
  const prev = useRef<StatsSample | null>(null);

  // Browser side: getStats() every second, only while the panel is mounted (open).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      setLocal(peer.debugInfo());
      setLog(peer.debugLog());
      const pc = peer.peerConnection;
      if (!pc) {
        prev.current = null;
        setStats(null);
        setThroughput(null);
        return;
      }
      try {
        const s = await sampleStats(pc);
        if (cancelled) return;
        const p = prev.current;
        if (p?.selectedPair && s.selectedPair && p.selectedPair.id === s.selectedPair.id) {
          const dt = (s.at - p.at) / 1000;
          setThroughput({
            sent: Math.max(0, s.selectedPair.bytesSent - p.selectedPair.bytesSent) / dt,
            received: Math.max(0, s.selectedPair.bytesReceived - p.selectedPair.bytesReceived) / dt,
          });
        } else setThroughput(null);
        prev.current = s;
        setStats(s);
        setStatsError(null);
      } catch (e) {
        if (!cancelled) setStatsError(errorMessage(e));
      }
    };
    void tick();
    const t = setInterval(() => void tick(), STATS_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [peer]);

  // Daemon side: the `debug.peer` RPC every few seconds while connected.
  const connected = conn.state === "connected";
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const tick = () =>
      peer.call("debug.peer", {}, 5000).then(
        (data) => !cancelled && setDaemon({ data, error: null, unsupported: false, at: Date.now() }),
        (e: unknown) => {
          if (cancelled) return;
          const msg = errorMessage(e);
          setDaemon((d) => ({ ...d, error: msg, unsupported: /unknown method/i.test(msg) }));
        },
      );
    void tick();
    const t = setInterval(() => void tick(), DAEMON_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [connected, peer, conn.generation]);

  return { local, log, stats, statsError, throughput, daemon };
}

// --- panel ---------------------------------------------------------------------------

export function DebugPanel({ onClose, className }: { onClose: () => void; className?: string }) {
  const { peer, device, info } = useDevice();
  const { local, log, stats, statsError, throughput, daemon } = useDebugData();
  const [relayOnly, setRelayOnly] = useState(forceRelay);
  const now = Date.now();
  const pair = stats?.selectedPair ?? null;
  const path = classifyPath(pair?.local ?? null, pair?.remote ?? null);

  const blob = {
    generatedAt: new Date(now).toISOString(),
    page: location.pathname,
    userAgent: navigator.userAgent,
    device: device
      ? { id: device.id, name: device.name, hostname: device.hostname, os: device.os, arch: device.arch, version: device.version }
      : { id: local.deviceId },
    daemonInfo: info.data ?? null,
    browser: {
      forceRelay: relayOnly,
      ...local,
      timeToConnectMs: local.offerSentAt && local.connectedAt ? local.connectedAt - local.offerSentAt : null,
      uptimeMs: local.state === "connected" && local.connectedAt ? now - local.connectedAt : null,
      path: path ? PATH_LABELS[path] : null,
      throughputBytesPerSec: throughput,
      stats,
      statsError,
    },
    daemon: daemon.unsupported ? { unsupported: true, error: daemon.error } : { view: daemon.data, error: daemon.error },
    log: log.map((e) => ({ ...e, time: new Date(e.at).toISOString() })),
  };

  return (
    <aside className={cn("flex min-h-0 flex-col border-l bg-sidebar", className)} aria-label="Connection debug">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b pr-1.5 pl-3">
        <BugIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Connection debug</span>
        <div className="ml-auto flex items-center gap-1">
          <CopyButton text={JSON.stringify(blob, null, 2)} label="Copy debug JSON" />
          <Button variant="ghost" size="icon-sm" onClick={() => peer.retry()} aria-label="Reconnect" title="Reconnect">
            <RotateCcwIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close debug panel" title="Close">
            <XIcon />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4 text-xs">
        <Group title="Connection">
          <PathBadge path={path} state={local.state} />
          <label className="flex cursor-pointer items-center gap-2 px-3 pb-1.5 text-muted-foreground select-none">
            <input
              type="checkbox"
              className="accent-primary"
              checked={relayOnly}
              onChange={(e) => {
                setForceRelay(e.target.checked);
                setRelayOnly(e.target.checked);
                peer.retry();
              }}
            />
            Force TURN relay (test the fallback path; applies to all devices)
          </label>
          <KV
            rows={[
              ["sid", local.sid ?? "—"],
              ["peer state", <StateText value={local.state} />],
              local.error ? ["error", <span className="text-destructive">{local.error}</span>] : null,
              ["connection", <StateText value={local.connectionState} />],
              ["ice connection", <StateText value={local.iceConnectionState} />],
              ["ice gathering", local.iceGatheringState ?? "—"],
              ["signaling", local.signalingState ?? "—"],
              [
                "time to connect",
                local.offerSentAt && local.connectedAt ? fmtDuration(local.connectedAt - local.offerSentAt) : "—",
              ],
              ["uptime", local.state === "connected" && local.connectedAt ? fmtDuration(now - local.connectedAt) : "—"],
              ["candidates", `${local.candidatesSent} sent · ${local.candidatesReceived} received`],
              local.reconnectAttempt > 0 ? ["reconnect attempt", String(local.reconnectAttempt)] : null,
            ]}
          />
        </Group>

        <Group title="Selected candidate pair">
          {statsError && <p className="text-destructive">{statsError}</p>}
          {!pair ? (
            <p className="text-muted-foreground">{peer.peerConnection ? "No pair selected yet." : "No connection."}</p>
          ) : (
            <KV
              rows={[
                ["local", pair.local ? <Candidate c={pair.local} /> : "—"],
                ["remote", pair.remote ? <Candidate c={pair.remote} /> : "—"],
                ["pair state", `${pair.state}${pair.nominated ? " · nominated" : ""}`],
                ["rtt", pair.currentRoundTripTime === null ? "—" : `${pair.currentRoundTripTime.toFixed(1)} ms`],
                [
                  "outgoing bitrate",
                  pair.availableOutgoingBitrate === null ? "—" : fmtBitrate(pair.availableOutgoingBitrate),
                ],
                [
                  "sent",
                  `${fmtBytes(pair.bytesSent)}${throughput ? ` · ${fmtRate(throughput.sent)}` : ""}`,
                ],
                [
                  "received",
                  `${fmtBytes(pair.bytesReceived)}${throughput ? ` · ${fmtRate(throughput.received)}` : ""}`,
                ],
                ["requests", `${pair.requestsSent} sent · ${pair.requestsReceived} received`],
                ["responses", `${pair.responsesSent} sent · ${pair.responsesReceived} received`],
              ]}
            />
          )}
        </Group>

        <Group title="Data channels">
          {!stats || stats.dataChannels.length === 0 ? (
            <p className="text-muted-foreground">None.</p>
          ) : (
            <Table
              head={["label", "state", "msgs ↑/↓", "bytes ↑/↓"]}
              rows={stats.dataChannels.map((d) => [
                d.label,
                <StateText value={d.state} />,
                `${d.messagesSent}/${d.messagesReceived}`,
                `${fmtBytes(d.bytesSent)}/${fmtBytes(d.bytesReceived)}`,
              ])}
            />
          )}
        </Group>

        <Group title="ICE candidates">
          <CandidateTable title="Local (browser)" list={stats?.localCandidates} selected={pair?.local?.id} />
          <CandidateTable title="Remote (daemon)" list={stats?.remoteCandidates} selected={pair?.remote?.id} />
        </Group>

        <Group title="Daemon's view">
          <DaemonSection view={daemon} />
        </Group>

        <Group title={`Event log (${log.length})`}>
          {log.length === 0 ? (
            <p className="text-muted-foreground">No events yet.</p>
          ) : (
            <ol className="flex flex-col gap-px font-mono text-[11px]">
              {[...log].reverse().map((e, i) => (
                <li key={`${e.at}-${log.length - i}`} className="flex gap-2">
                  <span className="shrink-0 text-muted-foreground/70 tabular-nums">{fmtClock(e.at)}</span>
                  <span
                    className={cn(
                      "min-w-0 break-words",
                      e.kind === "error" && "text-destructive",
                      e.kind === "state" && "text-foreground",
                      (e.kind === "signal" || e.kind === "ice" || e.kind === "info") && "text-muted-foreground",
                    )}
                  >
                    {e.message}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Group>
      </div>
    </aside>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b px-3 py-2.5 last:border-b-0">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

type Row = [string, React.ReactNode] | null;

function KV({ rows }: { rows: Row[] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
      {rows
        .filter((r): r is [string, React.ReactNode] => r !== null)
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 font-mono text-[11px] leading-[18px] break-all text-foreground">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

function StateText({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  const good = value === "connected" || value === "open" || value === "completed";
  const bad = value === "failed" || value === "closed" || value === "disconnected";
  return <span className={cn(good && "text-live", bad && "text-destructive", !good && !bad && "text-warn")}>{value}</span>;
}

function PathBadge({ path, state }: { path: PathKind | null; state: string }) {
  if (!path) {
    return (
      <div className="rounded-md border border-dashed px-2.5 py-1.5 text-muted-foreground">
        {state === "connected" ? "Path unknown" : "Not connected"}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-1.5 font-medium",
        path === "relay" ? "border-warn/30 bg-warn/10 text-warn" : "border-primary/25 bg-primary/10 text-primary",
      )}
    >
      {PATH_LABELS[path]}
    </div>
  );
}

function Candidate({ c }: { c: Pick<CandidateStat, "type" | "protocol" | "address" | "port"> }) {
  return (
    <span>
      <span className="text-muted-foreground">
        {c.type} {c.protocol}{" "}
      </span>
      <span className={cn(isTailscaleAddress(c.address) && "text-primary")}>{hostPort(c)}</span>
    </span>
  );
}

function Table({ head, rows, highlight }: { head: string[]; rows: React.ReactNode[][]; highlight?: number }) {
  return (
    <div className="overflow-x-auto rounded-md border bg-background/40">
      <table className="w-full text-left font-mono text-[11px]">
        <thead className="border-b text-muted-foreground">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-2 py-1 font-normal whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r, i) => (
            <tr key={i} className={cn(i === highlight && "bg-primary/10")}>
              {r.map((cell, j) => (
                <td key={j} className="px-2 py-1 whitespace-nowrap">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CandidateTable({
  title,
  list,
  selected,
}: {
  title: string;
  list: (CandidateStat | CandidateInfo)[] | undefined;
  selected?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{title}</span>
      {!list || list.length === 0 ? (
        <p className="text-muted-foreground">None.</p>
      ) : (
        <Table
          head={["type", "proto", "address", "port", "priority"]}
          highlight={selected ? list.findIndex((c) => "id" in c && c.id === selected) : undefined}
          rows={list.map((c) => [
            c.type,
            c.protocol,
            <span
              className={cn(
                "break-all whitespace-normal",
                isTailscaleAddress(c.address) && "text-primary",
                !c.address && "text-muted-foreground",
              )}
            >
              {c.address || HIDDEN}
            </span>,
            c.port ?? "—",
            "priority" in c && c.priority !== null ? c.priority : "—",
          ])}
        />
      )}
    </div>
  );
}

function DaemonSection({ view }: { view: DaemonView }) {
  if (view.unsupported) {
    return <p className="text-warn">Daemon doesn't support debug info (update it).</p>;
  }
  if (!view.data) {
    return <p className={view.error ? "text-destructive" : "text-muted-foreground"}>{view.error ?? "Loading…"}</p>;
  }
  const d = view.data;
  const sp = d.selectedPair;
  const path = sp ? classifyPath({ ...sp.local, id: "", priority: null }, { ...sp.remote, id: "", priority: null }) : null;
  return (
    <div className="flex flex-col gap-2">
      {view.error && <p className="text-destructive">Last refresh failed: {view.error}</p>}
      <KV
        rows={[
          ["sid", d.sid],
          ["connection", <StateText value={d.connectionState} />],
          ["ice connection", <StateText value={d.iceConnectionState} />],
          ["local", sp ? <Candidate c={sp.local} /> : "—"],
          ["remote", sp ? <Candidate c={sp.remote} /> : "—"],
          ["path", path ? PATH_LABELS[path] : "—"],
          ["terminals open", String(d.openTerminals)],
          ["connected for", fmtDuration(d.connectedForMs)],
        ]}
      />
      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">Interfaces</span>
        <ul className="flex flex-col gap-px rounded-md border bg-background/40 px-2 py-1 font-mono text-[11px]">
          {d.interfaces.length === 0 && <li className="text-muted-foreground">None reported.</li>}
          {d.interfaces.map((iface) => {
            const ts = iface.name.startsWith("tailscale") || iface.addresses.some((a) => isTailscaleAddress(a.split("/")[0] ?? a));
            return (
              <li key={iface.name} className="flex gap-2">
                <span className={cn("w-20 shrink-0 truncate", ts ? "text-primary" : "text-muted-foreground")}>
                  {iface.name}
                </span>
                <span className={cn("min-w-0 break-all", ts && "text-primary")}>{iface.addresses.join(", ") || "—"}</span>
              </li>
            );
          })}
        </ul>
      </div>
      <CandidateTable title="Daemon local candidates" list={d.localCandidates} />
      <CandidateTable title="Daemon remote candidates" list={d.remoteCandidates} />
    </div>
  );
}
