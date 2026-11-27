/**
 * The Windows helper's safety net, as the viewer sees it: armed by "Bring session back" or
 * "Turn on virtual display", it runs a SYSTEM task at `deadlineMs` unless the user says they can
 * still reach the PC. Polled only on a Windows host (one small file read on the server), and
 * `confirm` runs the helper's `Confirm` task.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";

export interface RescueState {
  action: string;
  armedMs: number;
  deadlineMs: number;
}

export const RESCUE_POLL_MS = 5000;

/** Anything else (an older host's 404 page, a half-written record) means nothing is armed. */
export function isRescueState(value: unknown): value is RescueState {
  const v = value as Partial<RescueState> | null;
  return !!v && typeof v.action === "string" && Number.isFinite(v.deadlineMs) && Number.isFinite(v.armedMs);
}

export function useHeadlessRescue(enabled: boolean): {
  rescue: RescueState | null;
  refresh: () => void;
  confirm: () => Promise<{ ok: boolean; message: string; pending?: boolean }>;
} {
  const [rescue, setRescue] = useState<RescueState | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!enabled) { setRescue(null); return; }
    let cancelled = false;
    api.get<RescueState | null>("/api/remote-desktop/headless-helper/rescue")
      .then((r) => { if (!cancelled) setRescue(isRescueState(r) ? r : null); })
      // An older host has no such route: nothing is armed as far as this viewer can tell.
      .catch(() => { if (!cancelled) setRescue(null); });
    return () => { cancelled = true; };
  }, [enabled, tick]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(refresh, RESCUE_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  const confirm = useCallback(async () => {
    try {
      return await api.post<{ ok: boolean; message: string; pending?: boolean }>("/api/remote-desktop/headless-helper/confirm");
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    } finally {
      refresh();
    }
  }, [refresh]);

  return { rescue, refresh, confirm };
}
