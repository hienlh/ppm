/**
 * The number on the Logs button: open issues AI calls a likely PPM bug. Asked for when a button
 * mounts, when the issues change, and every ten minutes — and not at all while the device has
 * the dot switched off, since asking is also what lets an Auto run start.
 *
 * The desktop rail and the phone drawer can both be mounted, so the count is read once for
 * every button showing it rather than once per button.
 */
import { useEffect, useSyncExternalStore } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import { LOGS_ISSUES_CHANGED } from "../../../shared/logs-api";
import { fetchIssuesSummary } from "./logs-client";

const POLL_MS = 10 * 60_000;

let count = 0;
let holders = 0;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();

function setCount(next: number) {
  if (next === count) return;
  count = next;
  for (const l of listeners) l();
}

function retain(): () => void {
  if (holders++ === 0) {
    const load = () => {
      fetchIssuesSummary().then((r) => setCount(r.likelyBugs), () => { /* the button stays as it was */ });
    };
    load();
    window.addEventListener(LOGS_ISSUES_CHANGED, load);
    const timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);
    stop = () => {
      window.removeEventListener(LOGS_ISSUES_CHANGED, load);
      clearInterval(timer);
    };
  }
  return () => {
    if (--holders > 0) return;
    stop?.();
    stop = null;
  };
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useLogsBadgeCount(): number {
  const enabled = useSettingsStore((s) => s.logsBadge);
  useEffect(() => (enabled ? retain() : undefined), [enabled]);
  const n = useSyncExternalStore(subscribe, () => count);
  return enabled ? n : 0;
}
