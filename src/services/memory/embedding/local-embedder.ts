import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { resolveBunPath } from "../../autostart-generator.ts";
import { EMBED_HOST_FILE } from "./embed-host-source.ts";
import {
  EMBED_BATCH_SIZE,
  LOCAL_EMBED_DTYPE,
  LOCAL_EMBED_MODEL,
  applyE5Prefix,
  type EmbedKind,
  type Embedder,
} from "./embedder.ts";

export const LOCAL_IDLE_MS = 10 * 60_000;
export const LOCAL_MAX_RESTARTS = 3;
export const LOCAL_RESTART_WINDOW_MS = 10 * 60_000;
/** How long a host told to stop (stdin closed) gets before it is killed. */
const STOP_GRACE_MS = 2_000;
const STDERR_TAIL_CHARS = 2_000;

export interface LocalEmbedderOptions {
  /** `embedInstallDir()`: holds `embed-host.mjs`, its `node_modules` and `models/`. */
  installDir: string;
  idleMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
}

interface Pending {
  size: number;
  resolve(vectors: number[][]): void;
  reject(err: Error): void;
}

interface Host {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  pending: Map<number, Pending>;
  /** Set when PPM ended it (idle, close): its exit is not a crash. */
  stopping: boolean;
  stderrTail: string;
  stdoutDone: Promise<void>;
  stderrDone: Promise<void>;
}

/**
 * The local model, run in a separate bun process from the install dir (a compiled PPM cannot load
 * `@huggingface/transformers` itself, and the model must stay off the server's main thread, 8.4).
 * Started on the first call, stopped after `idleMs` with nothing to do, sent batches of 16. A host
 * that dies on its own is started again on the next call, at most `maxRestarts` times within
 * `restartWindowMs`; past that the embedder reports unavailable until `reset()` (9.4).
 */
export class LocalEmbedder implements Embedder {
  readonly model = `local:${LOCAL_EMBED_MODEL}@${LOCAL_EMBED_DTYPE}`;

  private readonly installDir: string;
  private readonly idleMs: number;
  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private host: Host | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private crashTimes: number[] = [];
  private unavailable: string | null = null;
  private seq = 0;

  constructor(opts: LocalEmbedderOptions) {
    this.installDir = opts.installDir;
    this.idleMs = opts.idleMs ?? LOCAL_IDLE_MS;
    this.maxRestarts = opts.maxRestarts ?? LOCAL_MAX_RESTARTS;
    this.restartWindowMs = opts.restartWindowMs ?? LOCAL_RESTART_WINDOW_MS;
  }

  get pid(): number | null {
    return this.host?.proc.pid ?? null;
  }

  status(): { available: boolean; reason?: string } {
    if (this.unavailable) return { available: false, reason: this.unavailable };
    if (!existsSync(this.hostPath())) return { available: false, reason: notInstalled() };
    return { available: true };
  }

  /** Forget past crashes (Sync now, a settings change). */
  reset(): void {
    this.unavailable = null;
    this.crashTimes = [];
  }

  async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const prefixed = applyE5Prefix(texts, kind, LOCAL_EMBED_MODEL);
    const batches: string[][] = [];
    for (let i = 0; i < prefixed.length; i += EMBED_BATCH_SIZE) batches.push(prefixed.slice(i, i + EMBED_BATCH_SIZE));
    const results = await Promise.all(batches.map((b) => this.request(b, kind)));
    return results.flat().map((v) => Float32Array.from(v));
  }

  async close(): Promise<void> {
    const host = this.host;
    this.clearIdle();
    if (!host) return;
    this.stopHost(host, 0);
    await host.proc.exited;
  }

  private hostPath(): string {
    return join(this.installDir, EMBED_HOST_FILE);
  }

  private request(texts: string[], kind: EmbedKind): Promise<number[][]> {
    let host: Host;
    try {
      host = this.ensureHost();
    } catch (err) {
      return Promise.reject(err);
    }
    this.clearIdle();
    const id = ++this.seq;
    const done = new Promise<number[][]>((resolve, reject) => {
      host.pending.set(id, { size: texts.length, resolve, reject });
      try {
        // One write then flush: FileSink.write consumes the whole chunk (root CLAUDE.md).
        host.proc.stdin.write(JSON.stringify({ id, texts, kind }) + "\n");
        host.proc.stdin.flush();
      } catch (err) {
        host.pending.delete(id);
        reject(new Error(`Could not write to the local embedding host: ${(err as Error)?.message ?? err}`));
      }
    });
    return done.finally(() => this.armIdle(host));
  }

  private ensureHost(): Host {
    if (this.host) return this.host;
    if (this.unavailable) throw new Error(this.unavailable);
    const hostPath = this.hostPath();
    if (!existsSync(hostPath)) throw new Error(notInstalled());

    let proc: Host["proc"];
    try {
      // Bun.spawn throws synchronously on a missing binary; resolveBunPath throws without bun.
      proc = Bun.spawn({
        cmd: [resolveBunPath(), hostPath],
        cwd: this.installDir,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
    } catch (err) {
      throw new Error(`Could not start the local embedding host: ${(err as Error)?.message ?? err}`);
    }

    const host: Host = {
      proc,
      pending: new Map(),
      stopping: false,
      stderrTail: "",
      stdoutDone: Promise.resolve(),
      stderrDone: Promise.resolve(),
    };
    host.stdoutDone = readLines(proc.stdout, (line) => this.onLine(host, line));
    host.stderrDone = readText(proc.stderr, (chunk) => {
      host.stderrTail = (host.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    proc.exited.then((code) => this.onExit(host, code));
    this.host = host;
    return host;
  }

  private onLine(host: Host, line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not protocol (library noise)
    }
    if (!msg || typeof msg !== "object" || typeof msg.id !== "number") return;
    const p = host.pending.get(msg.id);
    if (!p) return;
    host.pending.delete(msg.id);
    if (typeof msg.error === "string") return p.reject(new Error(`Local embedding host: ${msg.error}`));
    const vectors = msg.vectors;
    if (!Array.isArray(vectors) || vectors.length !== p.size || !vectors.every(Array.isArray)) {
      return p.reject(new Error(`Local embedding host returned a malformed answer for ${p.size} texts`));
    }
    p.resolve(vectors);
  }

  private async onExit(host: Host, code: number | null): Promise<void> {
    if (this.host === host) {
      this.host = null;
      this.clearIdle();
    }
    if (!host.stopping) {
      const now = Date.now();
      this.crashTimes = this.crashTimes.filter((t) => now - t < this.restartWindowMs);
      this.crashTimes.push(now);
      if (this.crashTimes.length > this.maxRestarts) {
        this.unavailable =
          `Local embedding host unavailable: it stopped unexpectedly ${this.crashTimes.length} times ` +
          `within ${formatWindow(this.restartWindowMs)}`;
      }
    }
    if (host.pending.size === 0) return;
    // Let answers already written be read, and the stderr tail arrive, before failing the rest.
    await Promise.race([Promise.allSettled([host.stdoutDone, host.stderrDone]), Bun.sleep(500)]);
    const tail = host.stderrTail.trim().split("\n").slice(-5).join("\n");
    const err = new Error(`Local embedding host exited (code ${code ?? "signal"})${tail ? `: ${tail}` : ""}`);
    for (const p of host.pending.values()) p.reject(err);
    host.pending.clear();
  }

  private armIdle(host: Host): void {
    if (this.host !== host || host.pending.size > 0) return;
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.host === host && host.pending.size === 0) this.stopHost(host, STOP_GRACE_MS);
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Close its stdin (the host exits on EOF), and kill it if it is still there after `graceMs`. */
  private stopHost(host: Host, graceMs: number): void {
    host.stopping = true;
    if (this.host === host) this.host = null;
    try {
      host.proc.stdin.end();
    } catch {}
    if (graceMs <= 0) {
      host.proc.kill();
      return;
    }
    const t = setTimeout(() => {
      if (host.proc.exitCode === null && host.proc.signalCode === null) host.proc.kill();
    }, graceMs);
    t.unref?.();
  }
}

function notInstalled(): string {
  return "Local embedding model is not installed";
}

function formatWindow(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${ms} ms`;
}

async function readText(stream: ReadableStream<Uint8Array>, onChunk: (s: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      onChunk(decoder.decode(value, { stream: true }));
    }
  } catch {
    // the pipe closed under us: the exit handler reports it
  } finally {
    reader.releaseLock();
  }
}

function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  let buf = "";
  return readText(stream, (chunk) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  });
}
