import { useEffect, useRef, useState, useCallback } from "react";
import { getAuthToken } from "@/lib/api-client";
import type { MetricsHistoryPoint, MetricsSnapshot } from "../../types/system-metrics";
import { METRICS_HISTORY_MAX, METRICS_PING_INTERVAL_MS } from "../../types/system-metrics";
import { GROUPS_RETENTION, pingLease, deleteLease, withGroupsRetention } from "./resource-monitor-lease";

export { authHeaders, pingLease, deleteLease, withGroupsRetention } from "./resource-monitor-lease";

// ── Shared singleton state (multiple components share one EventSource) ─
//
// Two ref-counts drive one connection: `refCount` (anyone watching at all) and
// `processesRefCount` (anyone who opted into the full tier). The *desired* URL is
// derived from whether the latter is > 0; a mount/unmount that doesn't change that
// desire is a no-op reconnect-wise — only a change to the desired URL tears down and
// reconnects the EventSource.

let sharedEs: EventSource | null = null;
let refCount = 0;
let processesRefCount = 0;
let connectedProcesses = false; // which URL the live sharedEs was opened with
let sharedLatest: MetricsSnapshot | null = null;
let sharedHistory: MetricsHistoryPoint[] = [];
let sharedConnected = false;
let sharedSid: string | null = null;
let sharedTickCount = 0; // snapshot frames received since the current connection opened
let pingTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const cb of listeners) cb();
}

function stopLease() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  const sid = sharedSid;
  sharedSid = null;
  if (sid) void deleteLease(sid);
}

function startLease(sid: string) {
  sharedSid = sid;
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    const currentSid = sharedSid;
    if (currentSid) void pingLease(currentSid);
  }, METRICS_PING_INTERVAL_MS);
}

function desiredUrl(wantProcesses: boolean): string {
  const token = getAuthToken();
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  if (wantProcesses) params.set("processes", "1");
  const qs = params.toString();
  return `/api/system/resources/stream${qs ? `?${qs}` : ""}`;
}

function connect(wantProcesses: boolean) {
  if (sharedEs) return;
  sharedTickCount = 0;
  const es = new EventSource(desiredUrl(wantProcesses));
  connectedProcesses = wantProcesses;

  es.addEventListener("session", (e) => {
    try {
      const session: { sid: string } = JSON.parse((e as MessageEvent).data);
      if (session.sid) startLease(session.sid);
    } catch {
      /* an old-shaped or malformed session frame — the snapshot listener is the source of truth */
    }
  });

  es.addEventListener("snapshot", (e) => {
    try {
      const snapshot: MetricsSnapshot = JSON.parse((e as MessageEvent).data);
      sharedLatest = snapshot;
      const point: MetricsHistoryPoint = {
        ts: snapshot.ts,
        system: snapshot.system,
        groups: Object.fromEntries(
          snapshot.groups.map((g) => [g.key, { cpu: g.cpu, ramMB: g.ramMB }]),
        ),
      };
      sharedHistory = [...sharedHistory, point];
      if (sharedHistory.length > METRICS_HISTORY_MAX) {
        sharedHistory = sharedHistory.slice(-METRICS_HISTORY_MAX);
      }
      sharedHistory = withGroupsRetention(sharedHistory, GROUPS_RETENTION);
      sharedTickCount++;
      sharedConnected = true;
      notify();
    } catch {
      /* malformed frame — skip this tick, keep the connection */
    }
  });

  es.onerror = () => {
    sharedConnected = false;
    stopLease();
    if (sharedEs) {
      sharedEs.close();
      sharedEs = null;
    }
    notify();
    if (refCount > 0) {
      const wanted = processesRefCount > 0;
      setTimeout(() => {
        if (!sharedEs && refCount > 0) connect(wanted);
      }, 5000);
    }
  };

  es.onopen = () => {
    sharedConnected = true;
    notify();
  };

  sharedEs = es;
}

function disconnect() {
  stopLease();
  if (sharedEs) {
    sharedEs.close();
    sharedEs = null;
    sharedConnected = false;
    notify();
  }
}

/** Reconnect only when the desired tier actually differs from the live connection. */
function reconcile() {
  const wanted = processesRefCount > 0;
  if (refCount === 0) {
    disconnect();
    return;
  }
  if (!sharedEs) {
    connect(wanted);
    return;
  }
  if (connectedProcesses !== wanted) {
    disconnect();
    connect(wanted);
  }
}

// ── Hook ───────────────────────────────────────────────────────────────

export interface UseResourceMonitorOptions {
  /** Opt into the full tier: process rows + groups, at the cost of a heavier stream. */
  processes?: boolean;
}

export function useResourceMonitor(opts: UseResourceMonitorOptions = {}) {
  const [, forceUpdate] = useState(0);
  const mounted = useRef(true);
  const wantProcesses = !!opts.processes;

  const rerender = useCallback(() => {
    if (mounted.current) forceUpdate((n) => n + 1);
  }, []);

  useEffect(() => {
    mounted.current = true;
    listeners.add(rerender);
    refCount++;
    if (wantProcesses) processesRefCount++;
    reconcile();

    return () => {
      mounted.current = false;
      listeners.delete(rerender);
      refCount--;
      if (wantProcesses) processesRefCount--;
      reconcile();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconcile reads live module state, not this closure
  }, [rerender, wantProcesses]);

  return {
    latest: sharedLatest,
    history: sharedHistory,
    isConnected: sharedConnected,
    /** Snapshot frames received since the current connection opened — lets a
     *  consumer (or an e2e script) wait past the always-0.0%/n/a first tick. */
    tickCount: sharedTickCount,
  };
}
