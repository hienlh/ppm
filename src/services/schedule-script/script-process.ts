/**
 * One child process running one script (see `harness-source.ts` for its side of the protocol).
 * This side spawns it, answers its `ctx` calls, reads its output line by line, and stops it:
 * `stop()` aborts `ctx.signal` and SIGKILLs it if it has not finished within the grace period.
 */
import type { Subprocess } from "bun";
import { HARNESS_SOURCE } from "./harness-source.ts";
import { readLines } from "./script-log.ts";

export interface ScriptInit {
  schedule: { id: number; name: string; mode: string };
  project: { name: string; path: string };
  inputs: Record<string, unknown>;
  state: unknown;
  scriptPath: string;
  /** How often the child reports it is alive; 10 s when unset. */
  heartbeatMs?: number;
}

export interface ScriptExit {
  code: number | null;
  /** The harness reported `done`: the script's function returned or threw. */
  finished: boolean;
  /** What the script threw, or why it ended without finishing. Not yet masked. */
  error: string | null;
  /** `ctx.state` as JSON when the script finished, else null. */
  state: string | null;
  /** Set when PPM ended the run: a stop, a timeout, a missed heartbeat. */
  stopReason: string | null;
}

export interface SpawnScriptOptions {
  init: ScriptInit;
  cwd: string;
  /** Put in the child's environment, so a restarted PPM can tell its own leftover child apart. */
  token: string;
  onCall: (method: string, params: unknown) => Promise<unknown>;
  onLine: (line: string) => void;
  /** Kill the child when no heartbeat came for this long. Off when unset. */
  heartbeatTimeoutMs?: number;
}

/** Variables a child must not inherit. `NOTIFY_SOCKET` once let a child tell systemd PPM was stopping. */
const WITHHELD_ENV = ["NOTIFY_SOCKET", "LISTEN_FDS", "LISTEN_PID", "LISTEN_FDNAMES"];

export function childEnv(token: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !WITHHELD_ENV.includes(key)) env[key] = value;
  }
  return { ...env, BUN_BE_BUN: "1", PPM_SCHEDULE_RUN: token };
}

type ChildMessage =
  | { t: "ready" }
  | { t: "hb" }
  | { t: "call"; id: number; method: string; params: unknown }
  | { t: "done"; state: string | null; error: string | null };

export class ScriptProcess {
  readonly pid: number;
  readonly exited: Promise<ScriptExit>;
  private proc: Subprocess<"pipe", "pipe", "pipe">;
  private done: { state: string | null; error: string | null } | null = null;
  private stopReason: string | null = null;
  private lastBeat = Date.now();
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  private hasExited = false;

  constructor(private opts: SpawnScriptOptions) {
    this.proc = Bun.spawn([process.execPath, "--eval", HARNESS_SOURCE], {
      cwd: opts.cwd,
      env: childEnv(opts.token),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      serialization: "json",
      ipc: (message) => this.onMessage(message as ChildMessage),
    });
    this.pid = this.proc.pid;
    if (opts.heartbeatTimeoutMs) {
      const limit = opts.heartbeatTimeoutMs;
      this.beatTimer = setInterval(() => {
        if (Date.now() - this.lastBeat > limit) this.kill(`no heartbeat for ${Math.round(limit / 1000)} s`);
      }, Math.min(5000, limit));
    }
    const readers = Promise.all([
      readLines(this.proc.stdout, opts.onLine).catch(() => {}),
      readLines(this.proc.stderr, opts.onLine).catch(() => {}),
    ]);
    this.exited = this.proc.exited.then(async (code) => {
      this.hasExited = true;
      if (this.beatTimer) clearInterval(this.beatTimer);
      await readers;
      return this.exitInfo(code);
    });
  }

  /** Abort `ctx.signal`, then SIGKILL after `graceMs` if the script has not finished by then. */
  stop(reason: string, graceMs = 5000): Promise<ScriptExit> {
    if (!this.hasExited) {
      this.stopReason ??= reason;
      this.send({ t: "stop", reason });
      const timer = setTimeout(() => this.kill(reason), graceMs);
      void this.exited.then(() => clearTimeout(timer));
    }
    return this.exited;
  }

  kill(reason: string): void {
    if (this.hasExited) return;
    this.stopReason ??= reason;
    try { this.proc.kill("SIGKILL"); } catch { /* already gone */ }
  }

  private exitInfo(code: number | null): ScriptExit {
    if (this.done) return { code, finished: true, error: this.done.error, state: this.done.state, stopReason: this.stopReason };
    const error = this.stopReason
      ? `Stopped: ${this.stopReason}`
      : code === 0 ? null : `The script's process exited with code ${code ?? "unknown"} before it finished`;
    return { code, finished: false, error, state: null, stopReason: this.stopReason };
  }

  private onMessage(message: ChildMessage): void {
    if (!message || typeof message !== "object") return;
    if (message.t === "ready") this.send({ t: "init", ...this.opts.init });
    else if (message.t === "hb") this.lastBeat = Date.now();
    else if (message.t === "call") void this.answer(message.id, message.method, message.params);
    else if (message.t === "done") {
      this.done = { state: message.state, error: message.error };
      this.closeStdin(); // the harness exits once its stdin closes
    }
  }

  private async answer(id: number, method: string, params: unknown): Promise<void> {
    try {
      const value = await this.opts.onCall(method, params);
      this.send({ t: "result", id, ok: true, value });
    } catch (e) {
      this.send({ t: "result", id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private send(message: Record<string, unknown>): void {
    if (this.hasExited) return;
    try { this.proc.send(message); } catch { /* the child is going away */ }
  }

  private closeStdin(): void {
    try {
      const flushed = this.proc.stdin.end();
      if (flushed instanceof Promise) flushed.catch(() => {});
    } catch { /* already closed */ }
  }
}
