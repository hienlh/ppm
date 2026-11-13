/**
 * How many one-shot AI calls may run at once: at most `maxInFlight` (4) per extension and
 * `maxTotal` (8) across every extension, with up to `maxQueued` (32) more per extension waiting
 * their turn, each for at most `maxQueueWaitMs` (60 s). An in-flight cap rather than a rate
 * window, like the tab-open broker's: what costs quota is calls running together, and a loop
 * gone wrong is stopped by the queue filling up. The total cap is what keeps several extensions
 * — or one claiming several names in the worker all extensions share — from starting a pile of
 * Claude CLIs or Codex app-servers at once.
 *
 * Waiting calls are admitted in arrival order, skipping one whose own extension is still at its
 * cap. A call waiting here has not spent anything yet, so a cancel or the wait running out
 * simply takes it out of the line. The worker's RPC deadline includes this wait
 * (`timeoutMs + maxQueueWaitMs + 15 s`), so `QUEUE_TIMEOUT` always arrives first.
 */
import { OneShotError } from "../../providers/one-shot-error.ts";

export const AI_MAX_IN_FLIGHT = 4;
export const AI_MAX_IN_FLIGHT_TOTAL = 8;
export const AI_MAX_QUEUED = 32;
export const AI_MAX_QUEUE_WAIT_MS = 60_000;

export interface LimiterOptions {
  maxInFlight: number;
  maxTotal: number;
  maxQueued: number;
  maxQueueWaitMs: number;
  /** Timer seam for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Give the slot back. Safe to call more than once. */
export type ReleaseSlot = () => void;

interface Lane {
  running: number;
  queued: number;
}

interface Waiter {
  key: string;
  admit(): void;
}

export class ExtensionAiLimiter {
  private lanes = new Map<string, Lane>();
  private waiting: Waiter[] = [];
  private running = 0;
  private readonly opts: Required<LimiterOptions>;

  constructor(options: Partial<LimiterOptions> = {}) {
    this.opts = {
      maxInFlight: options.maxInFlight ?? AI_MAX_IN_FLIGHT,
      maxTotal: options.maxTotal ?? AI_MAX_IN_FLIGHT_TOTAL,
      maxQueued: options.maxQueued ?? AI_MAX_QUEUED,
      maxQueueWaitMs: options.maxQueueWaitMs ?? AI_MAX_QUEUE_WAIT_MS,
      setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    };
  }

  private lane(key: string): Lane {
    let lane = this.lanes.get(key);
    if (!lane) this.lanes.set(key, lane = { running: 0, queued: 0 });
    return lane;
  }

  private dropIfIdle(key: string, lane: Lane): void {
    if (lane.running === 0 && lane.queued === 0) this.lanes.delete(key);
  }

  private canRun(lane: Lane): boolean {
    return lane.running < this.opts.maxInFlight && this.running < this.opts.maxTotal;
  }

  private take(key: string, lane: Lane): ReleaseSlot {
    lane.running++;
    this.running++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lane.running--;
      this.running--;
      this.dropIfIdle(key, lane);
      this.admitWaiting();
    };
  }

  /** Admit waiting calls, oldest first, while some lane with a waiter has room. */
  private admitWaiting(): void {
    for (let i = 0; i < this.waiting.length && this.running < this.opts.maxTotal;) {
      const waiter = this.waiting[i]!;
      if (this.canRun(this.lane(waiter.key))) {
        this.waiting.splice(i, 1);
        waiter.admit();
      } else {
        i++;
      }
    }
  }

  /** Wait for a slot in `key`'s lane. Rejects with `QUEUE_FULL`, `QUEUE_TIMEOUT` or `ABORTED`. */
  acquire(key: string, signal?: AbortSignal): Promise<ReleaseSlot> {
    if (signal?.aborted) return Promise.reject(new OneShotError("ABORTED", "The call was cancelled"));
    const lane = this.lane(key);
    if (this.canRun(lane)) return Promise.resolve(this.take(key, lane));
    if (lane.queued >= this.opts.maxQueued) {
      this.dropIfIdle(key, lane);
      return Promise.reject(new OneShotError("QUEUE_FULL",
        `Too many AI calls: ${lane.running} running and ${lane.queued} waiting`));
    }
    return new Promise<ReleaseSlot>((resolve, reject) => {
      const leave = (error: OneShotError) => {
        const at = this.waiting.indexOf(waiter);
        if (at >= 0) this.waiting.splice(at, 1);
        lane.queued--;
        this.dropIfIdle(key, lane);
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
        key,
        admit: () => {
          done();
          lane.queued--;
          resolve(this.take(key, lane));
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      lane.queued++;
      this.waiting.push(waiter);
    });
  }

  /** Calls running and waiting for `key`, for logs and tests. */
  stats(key: string): { running: number; queued: number } {
    const lane = this.lanes.get(key);
    return { running: lane?.running ?? 0, queued: lane?.queued ?? 0 };
  }

  /** Calls running across every extension. */
  totalRunning(): number {
    return this.running;
  }
}
