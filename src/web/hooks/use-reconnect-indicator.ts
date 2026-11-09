import { useCallback, useEffect, useState } from "react";

/** What the chat shows while its socket is being re-established. */
export type ReconnectStage = "hidden" | "reconnecting" | "lost";

/** A reconnect that lands within this window is never shown — returning to the app should not flash. */
export const RECONNECT_SHOW_DELAY_MS = 800;
/** Past this the connection is reported lost and a retry is offered. */
export const RECONNECT_LOST_AFTER_MS = 8_000;

/**
 * Turns a raw `isReconnecting` flag into what is worth telling the user.
 *
 * A phone browser closes the socket of every page it sends to the background, so a
 * reconnect follows almost every return to PPM and usually finishes in well under a
 * second. Both timers restart whenever the page becomes visible again: timers frozen
 * while the page was hidden fire as soon as it resumes, which would otherwise report
 * a connection that started reconnecting a moment ago as lost.
 */
export function useReconnectIndicator(
  isReconnecting: boolean,
  showDelayMs = RECONNECT_SHOW_DELAY_MS,
  lostAfterMs = RECONNECT_LOST_AFTER_MS,
): { stage: ReconnectStage; restart: () => void } {
  const [stage, setStage] = useState<ReconnectStage>("hidden");
  const [epoch, setEpoch] = useState(0);
  const restart = useCallback(() => setEpoch((n) => n + 1), []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") restart();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [restart]);

  useEffect(() => {
    setStage("hidden");
    if (!isReconnecting) return;
    const show = setTimeout(() => setStage("reconnecting"), showDelayMs);
    const lost = setTimeout(() => setStage("lost"), lostAfterMs);
    return () => {
      clearTimeout(show);
      clearTimeout(lost);
    };
  }, [isReconnecting, showDelayMs, lostAfterMs, epoch]);

  return { stage, restart };
}
