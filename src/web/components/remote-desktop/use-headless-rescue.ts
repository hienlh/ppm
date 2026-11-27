/**
 * The Windows helper's safety net, as the viewer sees it. Armed by "Bring session back" or "Turn
 * on virtual display", it runs a SYSTEM task at `deadlineMs` unless confirmed.
 *
 * Nobody is asked to confirm any more: once a viewer has a proven picture (`use-picture-proof.ts`)
 * this hook runs the helper's `Confirm` task itself. The user hears about the net only when it
 * did run and turned the virtual display on (`notice`), in one sentence they can dismiss.
 * Polled only on a Windows host (two small file reads on the server).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";

export interface RescueState {
  action: string;
  armedMs: number;
  deadlineMs: number;
}

/** The net ran because nobody saw the PC in time: it turned the virtual display on, or had no
 *  driver to turn on. `at` is the run's time and the key it is dismissed by. */
export interface RescueNotice {
  at: string;
  outcome: "display-on" | "no-driver";
}

export const RESCUE_POLL_MS = 5000;
/** A confirm that failed (not one still pending) is tried again no sooner than this. */
export const CONFIRM_RETRY_MS = 60_000;
const NOTICE_SEEN_KEY = "ppm.remoteDesktop.rescueNoticeSeen";

/** Anything else (an older host's 404 page, a half-written record) means nothing is armed. */
export function isRescueState(value: unknown): value is RescueState {
  const v = value as Partial<RescueState> | null;
  return !!v && typeof v.action === "string" && Number.isFinite(v.deadlineMs) && Number.isFinite(v.armedMs);
}

export function isRescueNotice(value: unknown): value is RescueNotice {
  const v = value as Partial<RescueNotice> | null;
  return !!v && typeof v.at === "string" && (v.outcome === "display-on" || v.outcome === "no-driver");
}

/** `{ armed, notice }`, or a host from before the notice that answers with the record itself. */
export function parseRescueAnswer(value: unknown): { armed: RescueState | null; notice: RescueNotice | null } {
  if (isRescueState(value)) return { armed: value, notice: null };
  const v = value as { armed?: unknown; notice?: unknown } | null;
  return {
    armed: isRescueState(v?.armed) ? v.armed : null,
    notice: isRescueNotice(v?.notice) ? v.notice : null,
  };
}

function readSeen(): string | null {
  try { return localStorage.getItem(NOTICE_SEEN_KEY); } catch { return null; }
}

export function useHeadlessRescue(enabled: boolean, pictureProven: boolean): {
  armed: RescueState | null;
  notice: RescueNotice | null;
  dismissNotice: () => void;
  refresh: () => void;
} {
  const [armed, setArmed] = useState<RescueState | null>(null);
  const [notice, setNotice] = useState<RescueNotice | null>(null);
  const [seen, setSeen] = useState<string | null>(readSeen);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const attempt = useRef<{ key: number; at: number } | null>(null);

  useEffect(() => {
    if (!enabled) { setArmed(null); setNotice(null); return; }
    let cancelled = false;
    api.get<unknown>("/api/remote-desktop/headless-helper/rescue")
      .then((r) => {
        if (cancelled) return;
        const answer = parseRescueAnswer(r);
        setArmed(answer.armed);
        setNotice(answer.notice);
      })
      // An older host has no such route: nothing is armed as far as this viewer can tell.
      .catch(() => { if (!cancelled) { setArmed(null); setNotice(null); } });
    return () => { cancelled = true; };
  }, [enabled, tick]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(refresh, RESCUE_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  // A proven picture is the confirmation: once per armed record, again after a real failure.
  useEffect(() => {
    if (!enabled || !pictureProven || !armed) return;
    const now = Date.now();
    const last = attempt.current;
    if (last && last.key === armed.armedMs && now - last.at < CONFIRM_RETRY_MS) return;
    attempt.current = { key: armed.armedMs, at: now };
    api.post<{ ok: boolean; message: string; pending?: boolean }>("/api/remote-desktop/headless-helper/confirm")
      .then((r) => {
        // Pending: the PC is still answering; the next poll shows whether the record went.
        if (!r.ok && !r.pending) console.warn(`[remote-desktop] automatic confirm failed: ${r.message}`);
      })
      .catch((e: unknown) => console.warn(`[remote-desktop] automatic confirm failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(refresh);
  }, [enabled, pictureProven, armed, refresh]);

  const dismissNotice = useCallback(() => {
    if (!notice) return;
    try { localStorage.setItem(NOTICE_SEEN_KEY, notice.at); } catch { /* shown again next time */ }
    setSeen(notice.at);
  }, [notice]);

  return { armed, notice: notice && notice.at !== seen ? notice : null, dismissNotice, refresh };
}
