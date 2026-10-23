/**
 * How many one-shot AI calls one extension may run at once: at most `maxInFlight` (4), with up
 * to `maxQueued` (32) more waiting their turn, each for at most `maxQueueWaitMs` (60 s). An
 * in-flight cap rather than a rate window, like the tab-open broker's: what costs quota is
 * calls running together, and a loop gone wrong is stopped by the queue filling up.
 *
 * A call waiting here has not spent anything yet, so a cancel or the wait running out simply
 * takes it out of the line. The worker's RPC deadline includes this wait
 * (`timeoutMs + maxQueueWaitMs + 15 s`), so `QUEUE_TIMEOUT` always arrives first.
 */
import { OneShotError } from "../../providers/one-shot-error.ts";

export const AI_MAX_IN_FLIGHT = 4;
export const AI_MAX_QUEUED = 32;
export const AI_MAX_QUEUE_WAIT_MS = 60_000;

export interface LimiterOptions {
  maxInFlight: number;
  maxQueued: number;
  maxQueueWaitMs: number;
  /** Timer seam for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Give the slot back. Safe to call more than once. */
export type ReleaseSlot = () => void;

interface Waiter {
  admit(): void;
}

interface Lane {
  running: number;
  queue: Waiter[];
}

export class ExtensionAiLimiter {
  private lanes = new Map<string, Lane>();
  private readonly opts: Required<LimiterOptions>;

  constructor(options: Partial<LimiterOptions> = {}) {
    this.opts = {
      maxInFlight: options.maxInFlight ?? AI_MAX_IN_FLIGHT,
      maxQueued: options.maxQueued ?? AI_MAX_QUEUED,
      maxQueueWaitMs: options.maxQueueWaitMs ?? AI_MAX_QUEUE_WAIT_MS,
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    };
  }

  private lane(key: string): Lane {
    let lane = this.lanes.get(key);
    if (!lane) this.lanes.set(key, lane = { running: 0, queue: [] });
    return lane;
  }

  private releaser(key: string, lane: Lane): ReleaseSlot {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lane.running--;
      const next = lane.queue.shift();
      if (next) next.admit();
      else if (lane.running === 0) this.lanes.delete(key);
    };
  }

  /** Wait for a slot in `key`'s lane. Rejects with `QUEUE_FULL`, `QUEUE_TIMEOUT` or `ABORTED`. */
  acquire(key: string, signal?: AbortSignal): Promise<ReleaseSlot> {
    if (signal?.aborted) return Promise.reject(new OneShotError("ABORTED", "The call was cancelled"));
    const lane = this.lane(key);
    if (lane.running < this.opts.maxInFlight) {
      lane.running++;
      return Promise.resolve(this.releaser(key, lane));
    }
    if (lane.queue.length >= this.opts.maxQueued) {
      return Promise.reject(new OneShotError("QUEUE_FULL",
        `Too many AI calls: ${this.opts.maxInFlight} running and ${this.opts.maxQueued} waiting`));
    }
    return new Promise<ReleaseSlot>((resolve, reject) => {
      const leave = (error: OneShotError) => {
        const at = lane.queue.indexOf(waiter);
        if (at >= 0) lane.queue.splice(at, 1);
        if (lane.running === 0 && lane.queue.length === 0) this.lanes.delete(key);
        done();
        reject(error);
      };
      const timer = this.opts.setTimer(() => leave(new OneShotError("QUEUE_TIMEOUT",
        `Waited ${Math.round(this.opts.maxQueueWaitMs / 1000)} s for a free AI slot`)), this.opts.maxQueueWaitMs);
      const onAbort = () => leave(new OneShotError("ABORTED", "The call was cancelled"));
      const done = () => {
        this.opts.clearTimer(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter: Waiter = {
        admit: () => {
          done();
          lane.running++;
          resolve(this.releaser(key, lane));
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      lane.queue.push(waiter);
    });
  }

  /** Calls running and waiting for `key`, for logs and tests. */
  stats(key: string): { running: number; queued: number } {
    const lane = this.lanes.get(key);
    return { running: lane?.running ?? 0, queued: lane?.queue.length ?? 0 };
  }
}
