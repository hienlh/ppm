import { useCallback, useEffect, useRef, useState } from "react";
import { fetchThreads, ShareApiError, type ShareFailure } from "./share-api";
import { removeThread, upsertThread, type GuestThread } from "./share-thread-model";

/**
 * The link's threads, kept current by polling.
 *
 * Polling rather than a stream: a Cloudflare tunnel does not pass a closed connection on to
 * the origin, so a stream per reviewer would never be let go. A poll goes out every
 * {@link POLL_MS} while the page is visible, at once when it becomes visible again, and right
 * after the reviewer's own write; `If-None-Match` makes an unchanged answer a bodiless 304.
 * A 404 means the link stopped opening, and polling stops for good. An answer naming another
 * version than the page's means the owner re-pinned the link: the page says so and keeps
 * polling, since the threads are the link's and not the version's.
 */

export const POLL_MS = 10_000;
export const MAX_BACKOFF_MS = 60_000;

/**
 * How long until the next poll, or null for none while the page is hidden. A server that
 * asked for a wait gets at least that; failures in a row back off, doubling up to a minute.
 */
export function nextPollDelay(s: { visible: boolean; failures: number; retryAfterMs?: number }): number | null {
  if (!s.visible) return null;
  const backoff = Math.min(POLL_MS * 2 ** Math.max(0, s.failures), MAX_BACKOFF_MS);
  return Math.max(backoff, s.retryAfterMs ?? 0);
}

export interface ShareThreadsState {
  threads: GuestThread[];
  loaded: boolean;
  invalid: boolean;
  /** The owner re-pinned the link since this page loaded, so it shows an old version. */
  versionChanged: boolean;
  /** Fold a write's answer in at once, then poll so everyone else's changes follow. */
  applyThread: (thread: GuestThread) => void;
  applyDeleted: (id: string) => void;
  refresh: () => void;
}

/** Whether a poll's answer names another version than the one the page loaded. */
export function repinnedSince(shown: string, reported: string | null): boolean {
  return reported !== null && reported !== shown;
}

export function useShareThreads(
  code: string, key: string, versionId: string, onFailure: (f: ShareFailure) => void,
): ShareThreadsState {
  const [threads, setThreads] = useState<GuestThread[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [versionChanged, setVersionChanged] = useState(false);
  const etag = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const again = useRef(false);
  const failures = useRef(0);
  const stopped = useRef(false);
  const onFailureRef = useRef(onFailure);
  onFailureRef.current = onFailure;
  // The timer calls the current poll through this, so the two callbacks need not name each other.
  const pollRef = useRef<() => Promise<void>>(async () => {});

  const schedule = useCallback((retryAfterMs?: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (stopped.current) return;
    const delay = nextPollDelay({ visible: document.visibilityState === "visible", failures: failures.current, retryAfterMs });
    if (delay !== null) timer.current = setTimeout(() => { void pollRef.current(); }, delay);
  }, []);

  const poll = useCallback(async () => {
    if (stopped.current) return;
    if (inFlight.current) { again.current = true; return; }
    inFlight.current = true;
    let retryAfterMs: number | undefined;
    try {
      const answer = await fetchThreads(code, key, etag.current);
      failures.current = 0;
      if (!answer.unchanged) {
        etag.current = answer.etag;
        setThreads(answer.threads);
        if (repinnedSince(versionId, answer.versionId)) setVersionChanged(true);
      }
      setLoaded(true);
    } catch (e) {
      const failure: ShareFailure = e instanceof ShareApiError ? e.failure : { kind: "network" };
      if (failure.kind === "invalid") {
        stopped.current = true;
        setInvalid(true);
      } else {
        failures.current++;
        // A poll failing quietly is normal on a phone; only a wait the server asked for is news.
        if (failure.kind === "rate-limited") {
          retryAfterMs = failure.retryAfterMs;
          onFailureRef.current(failure);
        }
      }
    } finally {
      inFlight.current = false;
    }
    if (again.current) {
      again.current = false;
      void poll();
      return;
    }
    schedule(retryAfterMs);
  }, [code, key, versionId, schedule]);
  pollRef.current = poll;

  useEffect(() => {
    stopped.current = false;
    void poll();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
      else schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped.current = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poll, schedule]);

  const applyThread = useCallback((thread: GuestThread) => {
    setThreads((list) => upsertThread(list, thread));
    void poll();
  }, [poll]);
  const applyDeleted = useCallback((id: string) => {
    setThreads((list) => removeThread(list, id));
    void poll();
  }, [poll]);

  const refresh = useCallback(() => { void poll(); }, [poll]);

  return { threads, loaded, invalid, versionChanged, applyThread, applyDeleted, refresh };
}
