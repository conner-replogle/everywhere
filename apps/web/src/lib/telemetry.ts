import type { TelemetryCatalog, TelemetryQuery, TelemetryResult, TelemetryScope } from "@everywhere/protocol";
import { useEffect, useRef, useState } from "react";
import type { DevicePeer } from "@/lib/peer";
import { errorMessage } from "@/lib/utils";

/*
 * Charts ask the device for exactly what they draw (telemetry.query, bucketed
 * to their width) and ask again when telemetry.changed says their metric got
 * data; nothing is kept here between asks.
 */

/** A metric changes at most this often, as far as charts are concerned. */
const REFETCH_MS = 1000;

/**
 * Calls fn when a project's telemetry changes for an experiment (and, if
 * given, one of these metrics), at most every REFETCH_MS.
 */
export function useTelemetryChanged(
  peer: DevicePeer,
  home: string | undefined,
  experiment: string | undefined,
  metrics: string[] | undefined,
  fn: () => void,
) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const key = metrics?.join("\u0000");
  useEffect(() => {
    if (!home || !experiment) return;
    const wanted = key === undefined ? undefined : new Set(key.split("\u0000"));
    let last = 0;
    let timer = 0;
    const off = peer.onEvent((e) => {
      if (e.event !== "telemetry.changed" || e.home !== home) return;
      const changed = e.experiments[experiment];
      if (!changed || (wanted && changed.length > 0 && !changed.some((m) => wanted.has(m)))) return;
      if (timer) return;
      const wait = Math.max(0, last + REFETCH_MS - Date.now());
      timer = window.setTimeout(() => {
        timer = 0;
        last = Date.now();
        fnRef.current();
      }, wait);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [peer, home, experiment, key]);
}

interface Loaded<T> {
  data?: T;
  error?: string;
  loading: boolean;
}

/** An experiment's runs and metrics, kept current. */
export function useCatalog(peer: DevicePeer, scope: TelemetryScope, home: string | undefined, experiment: string | undefined) {
  const [state, setState] = useState<Loaded<TelemetryCatalog>>({ loading: true });
  const [tick, setTick] = useState(0);
  const scopeKey = JSON.stringify(scope);
  useEffect(() => {
    if (!experiment) return;
    let live = true;
    peer
      .call("telemetry.catalog", { ...(JSON.parse(scopeKey) as TelemetryScope), experiment })
      .then(
        (data) => live && setState({ data, loading: false }),
        (e) => live && setState((s) => ({ ...s, error: errorMessage(e), loading: false })),
      );
    return () => {
      live = false;
    };
  }, [peer, scopeKey, experiment, tick]);
  // New metrics or runs show up as their first data does.
  useTelemetryChanged(peer, home, experiment, undefined, () => setTick((t) => t + 1));
  return state;
}

/** A query's answer, asked again when its metric changes. */
export function useTelemetryQuery(
  peer: DevicePeer,
  scope: TelemetryScope,
  home: string | undefined,
  experiment: string | undefined,
  query: TelemetryQuery | null,
) {
  const [state, setState] = useState<Loaded<TelemetryResult>>({ loading: !!query });
  const [tick, setTick] = useState(0);
  const scopeKey = JSON.stringify(scope);
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    const q = JSON.parse(queryKey) as TelemetryQuery | null;
    if (!q) return;
    let live = true;
    peer
      .call("telemetry.query", { ...(JSON.parse(scopeKey) as TelemetryScope), query: q })
      .then(
        // Keeps showing the last answer until the next one lands.
        (data) => live && setState({ data, loading: false }),
        (e) => live && setState((s) => ({ ...s, error: errorMessage(e), loading: false })),
      );
    return () => {
      live = false;
    };
  }, [peer, scopeKey, queryKey, tick]);
  useTelemetryChanged(peer, home, experiment, query ? [query.metric] : undefined, () => setTick((t) => t + 1));
  return state;
}
