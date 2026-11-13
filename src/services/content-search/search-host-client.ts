/**
 * The server's side of the search host (`search-host.ts`): spawns `ppm __search__` once, hands it
 * requests over stdin and turns its reply frames back into `Blob`s.
 *
 * Everything here runs on the server's main thread, so it does as little as it can: it writes a
 * small header plus the caller's bytes, keeps the reply's chunks as `subarray`s (`FrameDecoder`)
 * and wraps them in a `Blob`. It never parses, decodes, sorts, or touches a project file, and it
 * imports none of the search code — a host that cannot start is a 503, never a search run here.
 *
 * - Lazy: the first request spawns the host; concurrent first requests share that one spawn.
 * - `ready` must arrive within `readyTimeoutMs` (5 s), or the host is killed: 503, one WARN.
 * - A host that exits fails what it was answering with 500; the next request spawns a fresh one.
 * - Each request has a deadline (35 s for a search: the host's own 30 s limit plus 5 s). A host
 *   that misses it is SIGKILLed, since a hung host would hang every later search too.
 * - An aborted request rejects at once with the signal's reason and sends the host a `cancel`.
 */
import { resolve } from "node:path";
import { isCompiledBinary } from "../autostart-generator.ts";
import { encodeFrame, FRAME_HEADER_BYTES, FRAME_KINDS, FrameDecoder, type Frame } from "./frame-codec.ts";
import { createLogger } from "../logger.ts";
import { TIME_LIMIT_MS } from "./search-options.ts";

export class SearchHostError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "SearchHostError";
  }
}

export interface SearchHostReply {
  body: Blob;
  gzip: boolean;
}

export interface SearchHostOptions {
  /** The host's command line; `searchHostCommand()` by default. */
  cmd?: string[];
  readyTimeoutMs?: number;
  /** A request's default deadline. */
  deadlineMs?: number;
  /** Called with the duration of every callback this client runs on the main thread (tests measure it). */
  onMainThreadTask?: (ms: number) => void;
  warn?: (message: string) => void;
}

export interface RequestOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
}

export interface SearchHost {
  /** The running host's pid; null while none runs. */
  readonly pid: number | null;
  ensureStarted(): Promise<void>;
  request(kind: "search" | "replace", payload: Uint8Array | Uint8Array[], options?: RequestOptions): Promise<SearchHostReply>;
  stop(): void;
}

export const READY_TIMEOUT_MS = 5_000;
/** The host stops its tool at `TIME_LIMIT_MS` and answers; this is how long the server waits for that answer. */
export const SEARCH_DEADLINE_MS = TIME_LIMIT_MS + 5_000;
/** A replace is bounded by its files, not by a tool's time limit; this only catches a host that hangs. */
export const REPLACE_DEADLINE_MS = 5 * 60_000;

/** `<bin> __search__` from a compiled binary, `bun run src/index.ts __search__` from a checkout. */
export function searchHostCommand(compiled = isCompiledBinary()): string[] {
  return compiled
    ? [process.execPath, "__search__"]
    : [process.execPath, "run", resolve(import.meta.dir, "../../index.ts"), "__search__"];
}

const encoder = new TextEncoder();

/** A replace frame's payload: `[u32 path length][path]` then the body untouched (its own part, not copied). */
export function replacePayload(projectPath: string, body: Uint8Array): Uint8Array[] {
  const path = encoder.encode(projectPath);
  const head = new Uint8Array(4 + path.byteLength);
  new DataView(head.buffer).setUint32(0, path.byteLength);
  head.set(path, 4);
  return [head, body];
}

/** A frame's 9-byte header for a payload sent as separate parts, so the parts are never concatenated. */
function frameHeader(kind: "search" | "replace", id: number, length: number): Uint8Array {
  const head = new Uint8Array(FRAME_HEADER_BYTES);
  const view = new DataView(head.buffer);
  view.setUint8(0, FRAME_KINDS[kind]);
  view.setUint32(1, id);
  view.setUint32(5, length);
  return head;
}

interface Pending {
  resolve: (reply: SearchHostReply) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

type HostProcess = ReturnType<typeof spawnHost>;

function spawnHost(cmd: string[]) {
  return Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: process.env });
}

interface Running {
  proc: HostProcess;
  ready: Promise<void>;
  pending: Map<number, Pending>;
  /** Set once the process is gone or being killed; requests no longer go to it. */
  dead: boolean;
}

export function createSearchHost(options: SearchHostOptions = {}): SearchHost {
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const task = options.onMainThreadTask;
  const warn = options.warn ?? ((message: string) => defaultWarn(message));
  let current: Running | null = null;
  let nextId = 1;

  /** Times `fn` as one main-thread task. */
  const timed = <T>(fn: () => T): T => {
    if (!task) return fn();
    const t0 = performance.now();
    try { return fn(); } finally { task(performance.now() - t0); }
  };

  function fail(run: Running, error: SearchHostError): void {
    for (const [id, p] of run.pending) {
      run.pending.delete(id);
      p.cleanup();
      p.reject(error);
    }
  }

  function kill(run: Running): void {
    run.dead = true;
    if (current === run) current = null;
    try { run.proc.kill("SIGKILL"); } catch {}
  }

  function start(): Running {
    const cmd = options.cmd ?? searchHostCommand();
    let proc: HostProcess;
    try {
      proc = spawnHost(cmd);
    } catch (error) {
      const message = `Search could not start: ${error instanceof Error ? error.message : String(error)}`;
      warn(message);
      throw new SearchHostError(503, message);
    }

    let onReady!: () => void;
    let onNotReady!: (error: SearchHostError) => void;
    let isReady = false;
    const ready = new Promise<void>((res, rej) => { onReady = res; onNotReady = rej; });
    ready.catch(() => {});
    const run: Running = { proc, ready, pending: new Map(), dead: false };

    const readyTimer = setTimeout(() => timed(() => {
      if (isReady || run.dead) return;
      const message = `Search could not start: the search process did not answer within ${readyTimeoutMs} ms`;
      warn(message);
      kill(run);
      onNotReady(new SearchHostError(503, message));
    }), readyTimeoutMs);

    const handleFrame = (frame: Frame) => {
      if (frame.kind === "ready") {
        isReady = true;
        clearTimeout(readyTimer);
        onReady();
        return;
      }
      const p = run.pending.get(frame.id);
      if (!p) return; // cancelled or timed out: the answer has nobody left to go to
      run.pending.delete(frame.id);
      p.cleanup();
      if (frame.kind === "reply") {
        // The first byte is the flags byte; drop it without copying.
        const first = frame.parts[0];
        const gzip = first !== undefined && first.byteLength > 0 && (first[0]! & 1) === 1;
        const parts = frame.parts.slice();
        if (parts.length) parts[0] = parts[0]!.subarray(1);
        p.resolve({ body: new Blob(parts as BlobPart[]), gzip });
      } else if (frame.kind === "reply-error") {
        // A short `{ status, message }`: small enough to read here.
        new Blob(frame.parts as BlobPart[]).text().then((text) => {
          let status = 500;
          let message = "Search failed";
          try {
            const parsed = JSON.parse(text) as { status?: number; message?: string };
            if (typeof parsed.status === "number") status = parsed.status;
            if (typeof parsed.message === "string") message = parsed.message;
          } catch {}
          p.reject(new SearchHostError(status, message));
        });
      }
    };

    const frames = new FrameDecoder();
    void (async () => {
      const reader = proc.stdout.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          timed(() => { for (const frame of frames.push(value)) handleFrame(frame); });
        }
      } catch (error) {
        // A corrupt stream (something in the host printed to stdout): nothing more can be read from it.
        if (!run.dead) {
          warn(`Search host output unreadable, killing it: ${error instanceof Error ? error.message : String(error)}`);
          kill(run);
        }
      } finally {
        try { reader.releaseLock(); } catch {}
      }
    })();

    void proc.exited.then((code) => timed(() => {
      clearTimeout(readyTimer);
      const wasDead = run.dead;
      run.dead = true;
      if (current === run) current = null;
      const reason = `the search process exited (code ${proc.signalCode ?? code})`;
      if (!isReady) {
        const message = `Search could not start: ${reason}`;
        if (!wasDead) warn(message);
        onNotReady(new SearchHostError(503, message));
      } else if (run.pending.size && !wasDead) {
        warn(`Search host ${reason}`);
      }
      fail(run, new SearchHostError(500, `Search failed: ${reason}`));
    }));

    return run;
  }

  function ensure(): Running {
    if (current && !current.dead) return current;
    current = start();
    return current;
  }

  function write(run: Running, parts: Uint8Array[]): void {
    for (const part of parts) run.proc.stdin.write(part);
    void run.proc.stdin.flush();
  }

  return {
    get pid() {
      return current && !current.dead ? current.proc.pid : null;
    },

    async ensureStarted() {
      await ensure().ready;
    },

    async request(kind, payload, requestOptions = {}) {
      const { signal } = requestOptions;
      signal?.throwIfAborted();
      const run = ensure();
      await run.ready;
      signal?.throwIfAborted();
      if (run.dead) throw new SearchHostError(500, "Search failed: the search process exited");

      const parts = payload instanceof Uint8Array ? [payload] : payload;
      const length = parts.reduce((n, p) => n + p.byteLength, 0);
      const id = nextId++;
      if (nextId > 0xffff_ffff) nextId = 1;
      const deadlineMs = requestOptions.deadlineMs ?? options.deadlineMs
        ?? (kind === "search" ? SEARCH_DEADLINE_MS : REPLACE_DEADLINE_MS);

      return new Promise<SearchHostReply>((resolvePromise, rejectPromise) => {
        const onAbort = () => timed(() => {
          if (!run.pending.delete(id)) return;
          clearTimeout(timer);
          if (!run.dead) {
            try { write(run, [encodeFrame("cancel", id)]); } catch {}
          }
          rejectPromise(signal!.reason);
        });
        const timer = setTimeout(() => timed(() => {
          const p = run.pending.get(id);
          if (!p) return;
          run.pending.delete(id);
          p.cleanup();
          warn(`Search host did not answer a ${kind} within ${deadlineMs} ms; killing it`);
          kill(run);
          rejectPromise(new SearchHostError(500, `Search failed: the search process did not answer within ${Math.round(deadlineMs / 1000)} s`));
        }), deadlineMs);
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        run.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, cleanup });
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          timed(() => write(run, [frameHeader(kind, id, length), ...parts]));
        } catch (error) {
          run.pending.delete(id);
          cleanup();
          rejectPromise(new SearchHostError(500, `Search failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
    },

    stop() {
      const run = current;
      if (!run) return;
      kill(run);
      fail(run, new SearchHostError(500, "Search failed: the search process was stopped"));
    },
  };
}

const log = createLogger("search-host");

function defaultWarn(message: string): void {
  log.warn(message);
}

let shared: SearchHost | null = null;

/** The server's one search host. */
export function getSearchHost(): SearchHost {
  shared ??= createSearchHost();
  return shared;
}

/** Stops the shared host if one was ever created (server shutdown). */
export function stopSearchHost(): void {
  shared?.stop();
}
