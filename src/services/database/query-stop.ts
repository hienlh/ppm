import type { RunQueryOptions } from "../../types/database.ts";

/**
 * Stopping a statement `runQuery` is running, on a time limit or when its caller goes away
 * (`RunQueryOptions`). Each driver supplies its own way to stop one — Postgres sends a cancel
 * request for the backend, MySQL issues `KILL QUERY` from a second session — and this arms it:
 * once, on whichever comes first, and remembering which it was. A driver that may finish a
 * stopped statement *successfully* (MySQL answers `KILL QUERY` during `SLEEP()` that way) asks
 * {@link QueryStop.reason} afterwards and throws anyway, so a stopped run never reads as a result.
 */

export type QueryStopReason = "timeout" | "aborted";

/** The run was stopped before it finished; nothing it produced is returned. */
export class QueryStoppedError extends Error {
  constructor(readonly reason: QueryStopReason, timeoutMs?: number) {
    super(reason === "timeout"
      ? `The query took longer than ${formatLimit(timeoutMs)} and was stopped.`
      : "The query was stopped: the call that started it was cancelled.");
  }
}

function formatLimit(ms: number | undefined): string {
  if (!ms) return "its time limit";
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

export interface QueryStop {
  /** Why the run was stopped, or null while it has not been. */
  reason(): QueryStopReason | null;
  /** Throws {@link QueryStoppedError} once the run has been stopped. */
  throwIfStopped(): void;
  /** Disarms the timer and the abort listener; call once the run has ended, however it ended. */
  dispose(): void;
}

/** Throws at once when the caller has already gone, before anything is sent. */
export function throwIfAborted(opts: RunQueryOptions | undefined): void {
  if (opts?.signal?.aborted) throw new QueryStoppedError("aborted");
}

/** Arms `stop` to run on `opts.timeoutMs` or on `opts.signal`'s abort, whichever comes first. */
export function armQueryStop(opts: RunQueryOptions | undefined, stop: () => void): QueryStop {
  let reason: QueryStopReason | null = null;
  const fire = (why: QueryStopReason) => {
    if (reason) return;
    reason = why;
    try {
      stop();
    } catch {
      // The statement already ended; there is nothing left to stop.
    }
  };
  const timeoutMs = opts?.timeoutMs;
  const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => fire("timeout"), timeoutMs) : undefined;
  const onAbort = () => fire("aborted");
  const signal = opts?.signal;
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    reason: () => reason,
    throwIfStopped() {
      if (reason) throw new QueryStoppedError(reason, timeoutMs);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}
