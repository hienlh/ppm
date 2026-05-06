import { useEffect, useRef, useState, useCallback } from "react";
import { getAuthToken } from "@/lib/api-client";

// ── Types (mirrors backend) ────────────────────────────────────────────

export interface ResourceGroup {
  type: "server" | "terminal" | "ai-tool" | "build" | "unknown";
  label: string;
  cpu: number;
  ramMB: number;
  processes: { pid: number; cpu: number; ramMB: number; startedAt?: number; command: string }[];
}

export interface ResourceSnapshot {
  timestamp: number;
  server: { pid: number; cpu: number; ramMB: number };
  total: { cpu: number; ramMB: number; processCount: number };
  groups: ResourceGroup[];
}

const HISTORY_MAX = 600;

// ── Shared singleton state (multiple components share one EventSource) ─

let sharedEs: EventSource | null = null;
let refCount = 0;
let sharedLatest: ResourceSnapshot | null = null;
let sharedHistory: ResourceSnapshot[] = [];
let sharedConnected = false;
const listeners = new Set<() => void>();

function notify() {
  for (const cb of listeners) cb();
}

function connect() {
  if (sharedEs) return;
  const token = getAuthToken();
  const params = token ? `?token=${encodeURIComponent(token)}` : "";
  const es = new EventSource(`/api/system/resources/stream${params}`);

  es.addEventListener("snapshot", (e) => {
    try {
      const snapshot: ResourceSnapshot = JSON.parse(e.data);
      sharedLatest = snapshot;
      sharedHistory = [...sharedHistory, snapshot];
      if (sharedHistory.length > HISTORY_MAX) {
        sharedHistory = sharedHistory.slice(-HISTORY_MAX);
      }
      sharedConnected = true;
      notify();
    } catch {}
  });

  es.onerror = () => {
    sharedConnected = false;
    // Close stale ES and manually reconnect with backoff to avoid duplicate connections
    if (sharedEs) {
      sharedEs.close();
      sharedEs = null;
    }
    notify();
    if (refCount > 0) {
      setTimeout(() => { if (!sharedEs && refCount > 0) connect(); }, 5000);
    }
  };

  es.onopen = () => {
    sharedConnected = true;
    notify();
  };

  sharedEs = es;
}

function disconnect() {
  if (sharedEs) {
    sharedEs.close();
    sharedEs = null;
    sharedConnected = false;
    notify();
  }
}

// ── Hook ───────────────────────────────────────────────────────────────

export function useResourceMonitor() {
  const [, forceUpdate] = useState(0);
  const mounted = useRef(true);

  const rerender = useCallback(() => {
    if (mounted.current) forceUpdate((n) => n + 1);
  }, []);

  useEffect(() => {
    mounted.current = true;
    listeners.add(rerender);
    refCount++;
    if (refCount === 1) connect();

    return () => {
      mounted.current = false;
      listeners.delete(rerender);
      refCount--;
      if (refCount === 0) disconnect();
    };
  }, [rerender]);

  return {
    latest: sharedLatest,
    history: sharedHistory,
    isConnected: sharedConnected,
  };
}
