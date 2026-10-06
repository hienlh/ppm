/**
 * ONE long-lived PowerShell child for the polling lifetime.
 *
 * Why not spawn per tick: every `powershell.exe` spawn costs a 32 MiB allocator
 * segment Bun never returns to the OS (see windows-process-tree.ts) and ~400 ms
 * versus ~140 ms in-session. Requests are serialised, time-limited, and a
 * failed child may be restarted only a fixed number of times for the server's
 * whole life — a refilling budget would re-arm against a permanently wedged
 * CIM provider and spawn hundreds of times a day.
 */
import { defaultPsSpawner, encodeRequestLine, type PsChild, type PsSpawner } from "./powershell-session-bootstrap.ts";
import { createLogger, type Logger } from "../logger.ts";

export { POWERSHELL_BOOTSTRAP, defaultPsSpawner, type PsChild, type PsSpawner } from "./powershell-session-bootstrap.ts";

export interface PowerShellSessionOptions {
  spawn?: PsSpawner;
  /** Measured p95 real tick is 206 ms; 5 s only fires on a wedged CIM provider. */
  requestTimeoutMs?: number;
  /** Absolute cap for the server's lifetime — a refilling budget would re-arm
   *  against a permanently wedged provider and spawn hundreds of times a day. */
  maxRestarts?: number;
  /** Child working set creeps over hours; a scheduled recycle is free of the budget. */
  recycleAfterMs?: number;
  now?: () => number;
  /** The child's start, failures, stop and the session being given up on. */
  log?: Logger;
}

export const PS_DISABLED_WARNING = "Windows process collection disabled after repeated PowerShell failures";

export class PsSessionBusyError extends Error { constructor() { super("PowerShell request already in flight"); } }
export class PsSessionDisabledError extends Error { constructor() { super(PS_DISABLED_WARNING); } }

interface Pending { id: string; resolve: (s: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

/** Anything larger than this without an end marker is not a reply we want. */
const MAX_BUFFER_CHARS = 8 * 1024 * 1024;
/** How much of the child's stderr a failure line quotes. */
const STDERR_TAIL_CHARS = 300;

export class PowerShellSession {
  private readonly spawn: PsSpawner;
  private readonly requestTimeoutMs: number;
  private readonly maxRestarts: number;
  private readonly recycleAfterMs: number;
  private readonly now: () => number;
  private readonly log: Logger;

  private child: PsChild | null = null;
  private generation = 0;
  private spawnedAt = 0;
  private restarts = 0;
  private everStarted = false;
  private previousDiedAbnormally = false;
  private disabled = false;
  private buffer = "";
  /** The end of the current child's stderr, which says why it died when anything does. */
  private stderrTail = "";
  private pending: Pending | null = null;
  private nextId = 1;

  constructor(opts: PowerShellSessionOptions = {}) {
    this.spawn = opts.spawn ?? defaultPsSpawner;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5000;
    this.maxRestarts = opts.maxRestarts ?? 5;
    this.recycleAfterMs = opts.recycleAfterMs ?? 6 * 60 * 60 * 1000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? createLogger("SystemMetrics");
  }

  isHealthy(): boolean { return this.child !== null && !this.disabled; }
  isDisabled(): boolean { return this.disabled; }
  isBusy(): boolean { return this.pending !== null; }
  restartCount(): number { return this.restarts; }
  childPid(): number | null { return this.child?.pid ?? null; }

  request(script: string): Promise<string> {
    if (this.disabled) return Promise.reject(new PsSessionDisabledError());
    if (this.pending) return Promise.reject(new PsSessionBusyError());
    let reason: "resume" | "recycle" = "resume";
    if (this.child && this.now() - this.spawnedAt >= this.recycleAfterMs) {
      this.stop();
      reason = "recycle";
    }
    if (!this.child) {
      try { this.start(reason); } catch (e) { return Promise.reject(e as Error); }
    }
    const child = this.child!;
    const id = String(this.nextId++);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => this.onFailure(`PowerShell request timed out after ${this.requestTimeoutMs} ms`), this.requestTimeoutMs);
      this.pending = { id, resolve, reject, timer };
      try {
        child.stdin.write(encodeRequestLine(id, script));
        child.stdin.flush?.();
      } catch (e) {
        this.onFailure(`PowerShell stdin write failed: ${(e as Error).message}`);
      }
    });
  }

  /** Write nothing, kill, clear. Safe to call repeatedly. No subscribers must mean no child. */
  stop(): void {
    if (this.child) this.log.info(`PowerShell session stopped pid=${this.child.pid}`);
    this.teardown(new Error("PowerShell session stopped"));
  }

  private teardown(pendingError: Error): void {
    const child = this.child;
    this.child = null;
    this.generation++;
    this.buffer = "";
    this.failPending(pendingError);
    if (child) { try { child.kill(); } catch { /* already gone */ } }
  }

  /** `reason` is why a healthy session needs a child: the first one, or a restart after a
   *  failure, are told apart here. */
  private start(reason: "resume" | "recycle"): void {
    const why = !this.everStarted ? "first" : this.previousDiedAbnormally ? "restart" : reason;
    if (this.everStarted && this.previousDiedAbnormally) {
      if (this.restarts >= this.maxRestarts) {
        this.disabled = true;
        // For the rest of the server's life: the Processes page stays empty from here on.
        this.log.error(`PowerShell collector disabled after ${this.restarts} restarts`);
        throw new PsSessionDisabledError();
      }
      this.restarts++;
    }
    this.everStarted = true;
    this.previousDiedAbnormally = false;
    const gen = ++this.generation;
    const child = this.spawn();
    this.child = child;
    this.spawnedAt = this.now();
    this.buffer = "";
    this.stderrTail = "";
    this.log.info(`PowerShell session started pid=${child.pid} reason=${why}`);
    void this.pump(child, gen);
    void drain(child.stderr, (text) => {
      if (gen === this.generation) this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_CHARS);
    });
    child.exited.then(
      () => { if (gen === this.generation) this.onFailure("PowerShell exited unexpectedly"); },
      () => { if (gen === this.generation) this.onFailure("PowerShell exited unexpectedly"); },
    );
  }

  private async pump(child: PsChild, gen: number): Promise<void> {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || gen !== this.generation) break;
        this.buffer += decoder.decode(value, { stream: true });
        this.scan();
      }
    } catch { /* stream torn down with the child */ }
    if (gen === this.generation) this.onFailure("PowerShell stdout closed");
  }

  /** Resolve the pending request on ITS marker; discard any stale marker's output. */
  private scan(): void {
    while (true) {
      const m = /__END_(\d+)__/.exec(this.buffer);
      if (!m) {
        if (this.buffer.length > MAX_BUFFER_CHARS) this.buffer = "";
        return;
      }
      const reply = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length).replace(/^\r?\n/, "");
      const p = this.pending;
      if (p && p.id === m[1]) {
        this.pending = null;
        clearTimeout(p.timer);
        p.resolve(reply);
      }
    }
  }

  /** Timeout, exit or write failure: kill, mark for a counted restart, reject. */
  private onFailure(reason: string): void {
    const stderr = this.stderrTail.replace(/\s+/g, " ").trim();
    this.log.warn(
      `PowerShell session failed: ${reason} pid=${this.child?.pid ?? "?"} restarts=${this.restarts}/${this.maxRestarts}` +
        (stderr ? `: ${stderr}` : ""),
    );
    this.previousDiedAbnormally = true;
    this.teardown(new Error(reason));
  }

  private failPending(error: Error): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(error);
  }
}

/** A full stderr pipe would block the child; read it, handing each chunk's text on. */
async function drain(stream: ReadableStream<Uint8Array> | null | undefined, onText: (text: string) => void): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  try {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      onText(decoder.decode(value, { stream: true }));
    }
  } catch { /* closed with the child */ }
}
