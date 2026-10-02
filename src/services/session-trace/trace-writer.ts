import { appendBatch, type TraceRow } from "./session-trace-store.ts";

/**
 * Buffers trace rows and commits them in one transaction per interval.
 *
 * One synchronous INSERT per streamed event is hundreds of sync writes per turn on the one
 * event loop — the `self` cause `event-loop-lag.ts` exists to catch. So rows wait here and go
 * down together every `intervalMs`, or at once when a turn ends. And the append can never
 * break the yield: a failed write logs and drops, it never throws to the caller.
 */
export interface TraceWriterDeps {
  write: (rows: readonly TraceRow[]) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  warn: (message: string) => void;
}

/** Past this many buffered rows the batch goes down at once rather than waiting out the timer. */
const MAX_BUFFERED_ROWS = 2_000;

export class TraceWriter {
  private buffer: TraceRow[] = [];
  private timer: unknown = null;

  constructor(private readonly deps: TraceWriterDeps, private readonly intervalMs = 250) {}

  enqueue(row: TraceRow): void {
    this.buffer.push(row);
    if (this.buffer.length >= MAX_BUFFERED_ROWS) {
      this.flush();
      return;
    }
    if (this.timer == null) {
      this.timer = this.deps.setTimer(() => {
        this.timer = null;
        this.flush();
      }, this.intervalMs);
    }
  }

  /** Commit everything buffered, now. Never throws. */
  flush(): void {
    if (this.timer != null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const rows = this.buffer;
    this.buffer = [];
    try {
      this.deps.write(rows);
    } catch (e) {
      try { this.deps.warn(`[session-trace] dropped ${rows.length} row(s): ${(e as Error)?.message ?? e}`); } catch { /* never throw */ }
    }
  }

  get pending(): number {
    return this.buffer.length;
  }
}

let lastWarnAt = 0;

export const traceWriter = new TraceWriter({
  write: appendBatch,
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    // A CLI run must not stay alive a quarter-second for a timer: the run's end flushes.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  warn: (message) => {
    // A full disk fails every batch; one line a minute says so without flooding the log.
    const now = Date.now();
    if (now - lastWarnAt < 60_000) return;
    lastWarnAt = now;
    console.warn(message);
  },
});

// bun:sqlite is synchronous, so an exit handler can still commit what is buffered.
process.once("exit", () => traceWriter.flush());
