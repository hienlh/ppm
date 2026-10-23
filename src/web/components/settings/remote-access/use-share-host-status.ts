import { useCallback, useEffect, useState } from "react";
import { shareHostApi, type ShareHostStatus } from "@/lib/api-share-host";

const POLL_MS = 10_000;
/** While the switch is on and the address is not connected: it usually is within seconds. */
const CONNECTING_POLL_MS = 2_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface ShareHostStatusFeature {
  status: ShareHostStatus | null;
  /** For an optimistic switch: the server's answer replaces it on the next read. */
  setStatus: (update: (s: ShareHostStatus | null) => ShareHostStatus | null) => void;
  loadError: string | null;
  refresh: () => Promise<void>;
  /** Switched on, not connected yet. */
  connecting: boolean;
}

/**
 * The review address's settings and what runs, read while `active`: on mount, on window focus,
 * and on a timer. A switch only writes config and the supervisor applies it, so the timer runs
 * faster while the address is on but not connected.
 */
export function useShareHostStatus(active = true): ShareHostStatusFeature {
  const [status, setStatus] = useState<ShareHostStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await shareHostApi.status());
      setLoadError(null);
    } catch (e) {
      // Keep the last known state: a failed poll is not a state change.
      setLoadError(message(e));
    }
  }, []);

  const connecting = !!status?.enabled && !status.connected;

  useEffect(() => {
    if (!active) return;
    void refresh();
    const reload = () => { void refresh(); };
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [active, refresh]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, connecting ? CONNECTING_POLL_MS : POLL_MS);
    return () => clearInterval(timer);
  }, [active, connecting, refresh]);

  return { status, setStatus, loadError, refresh, connecting };
}
