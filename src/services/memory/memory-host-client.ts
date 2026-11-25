/**
 * The server's side of the memory host (`memory-host.ts`): spawns `ppm __memory__` once, sends it
 * requests as JSON lines and hands its events to one listener (the `/ws/global` broadcast).
 *
 * Everything here runs on the server's main thread and imports none of the memory code that
 * reads a file or the index: a host that cannot start is an error the caller handles (a chat goes
 * out without its memory list, a tool answers an error, Settings a 503), never memory work run in
 * the server.
 *
 * - Lazy: the first request spawns the host; concurrent first requests share that one spawn.
 * - `ready` must arrive within `READY_TIMEOUT_MS`, or the host is killed and the request fails.
 * - A host that exits fails what it was answering; the next request spawns a fresh one.
 * - Each request has its own deadline. Three missed in a row means the host is hung: it is killed.
 * - Before a request, the config the host works from (memory settings, Codex homes, projects) is
 *   sent again if it changed or the host is new.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { homedir } from "node:os";
import type { Readable, Writable } from "node:stream";
import { join, resolve } from "node:path";
import { isCompiledBinary } from "../autostart-generator.ts";
import { createLogger } from "../logger.ts";
import { textResult, type Json } from "../mcp-http-endpoint.ts";
import type { MemoryToolsBinding } from "../tab-tools-mcp/memory-tools.ts";
import type { MemoryHostConfig, MemoryHostOp, MemoryHostRequests } from "./memory-host.ts";
import type { MemoryRuntimeEvent } from "./memory-runtime.ts";
import type { LocalInstallStatus } from "./embedding/local-install.ts";

const log = createLogger("memory-host");

export const READY_TIMEOUT_MS = 10_000;
/** A request that names none; a hung host is caught by three of these in a row. */
export const DEFAULT_DEADLINE_MS = 30_000;
/** Sync now covers every project; the first sync of a large Codex history can take a while. */
export const SYNC_ALL_DEADLINE_MS = 10 * 60_000;
/** A local model loading for the first time answers its test within a minute. */
export const LOCAL_TEST_DEADLINE_MS = 60_000;
const HUNG_AFTER_TIMEOUTS = 3;

export class MemoryHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryHostError";
  }
}

/** How requests reach a host: a spawned process here, the host's own handler in tests. */
export interface MemoryHostChannel {
  /** Changes whenever a new host starts, so its config is sent again. */
  generation(): number;
  /** The running host's pid; null while none runs (or in-process). */
  pid(): number | null;
  request(op: string, args: unknown, deadlineMs: number): Promise<unknown>;
  setListener(fn: ((event: MemoryRuntimeEvent) => void) | null): void;
  stop(): void;
}

/** `<bin> __memory__` from a compiled binary, `bun run src/index.ts __memory__` from a checkout. */
export function memoryHostCommand(compiled = isCompiledBinary()): string[] {
  return compiled
    ? [process.execPath, "__memory__"]
    : [process.execPath, "run", resolve(import.meta.dir, "../../index.ts"), "__memory__"];
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The host must never keep a process alive by itself (a `ppm chat` CLI that used memory would not
 * exit), so the child and its stdout are unref'd once, at spawn; while a request waits, its
 * deadline timer keeps the loop running and the reply still arrives. Measured on Bun 1.3:
 * - a pending read of a `Bun.spawn` stdout keeps the process alive even with the child unref'd,
 *   hence `node:child_process`;
 * - `ref()` after `unref()` (on the child or its stdout) cannot be undone by a later `unref()`,
 *   hence no ref/unref per request.
 */
function spawnHost(cmd: string[]): ChildProcessByStdio<Writable, Readable, null> {
  const proc = spawn(cmd[0]!, cmd.slice(1), { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  proc.unref();
  (proc.stdout as Readable & { unref?: () => void }).unref?.();
  return proc;
}

interface Running {
  proc: ChildProcessByStdio<Writable, Readable, null>;
  ready: Promise<void>;
  pending: Map<number, Pending>;
  dead: boolean;
}

export interface ProcessChannelOptions {
  cmd?: string[];
  readyTimeoutMs?: number;
}

/** The host as a child process speaking JSON lines. */
export function processMemoryChannel(options: ProcessChannelOptions = {}): MemoryHostChannel {
  const cmd = options.cmd ?? memoryHostCommand();
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  let current: Running | null = null;
  let generation = 0;
  let nextId = 1;
  let timeoutsInARow = 0;
  let listener: ((event: MemoryRuntimeEvent) => void) | null = null;

  function fail(run: Running, message: string): void {
    run.dead = true;
    if (current === run) current = null;
    for (const [, p] of run.pending) {
      clearTimeout(p.timer);
      p.reject(new MemoryHostError(message));
    }
    run.pending.clear();
  }

  function start(): Running {
    const proc = spawnHost(cmd);
    generation++;
    let markReady!: () => void;
    let markFailed!: (e: unknown) => void;
    const ready = new Promise<void>((res, rej) => { markReady = res; markFailed = rej; });
    ready.catch(() => undefined);
    const run: Running = { proc, ready, pending: new Map(), dead: false };
    const readyTimer = setTimeout(() => {
      markFailed(new MemoryHostError(`the memory host did not start within ${readyTimeoutMs / 1000} s`));
      log.warn(`memory host pid=${proc.pid} did not start within ${readyTimeoutMs / 1000} s; killed`);
      fail(run, "the memory host did not start");
      proc.kill("SIGKILL");
    }, readyTimeoutMs);

    const decoder = new TextDecoder();
    let buffer = "";
    proc.stdout.on("data", (chunk: Uint8Array) => {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) receive(run, line, () => { clearTimeout(readyTimer); markReady(); });
      }
    });
    // A write to a host that just died: the exit below fails what was pending.
    proc.stdin.on("error", () => undefined);

    const gone = (why: string) => {
      clearTimeout(readyTimer);
      markFailed(new MemoryHostError(`the memory host ${why}`));
      if (!run.dead) log.warn(`memory host pid=${proc.pid ?? "?"} ${why}; the next request starts a new one`);
      fail(run, `the memory host ${why}`);
    };
    proc.on("error", (e) => gone(`could not start: ${e.message}`));
    proc.on("exit", (code, signal) => gone(`exited (${signal ?? `code ${code}`})`));
    return run;
  }

  function receive(run: Running, line: string, onReady: () => void): void {
    let msg: { ready?: boolean; event?: MemoryRuntimeEvent; id?: number; ok?: boolean; result?: unknown; error?: string };
    try { msg = JSON.parse(line); } catch {
      log.warn(`memory host wrote a line that is not JSON: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.ready) return onReady();
    if (msg.event) return listener?.(msg.event);
    if (typeof msg.id !== "number") return;
    const p = run.pending.get(msg.id);
    if (!p) return;
    run.pending.delete(msg.id);
    clearTimeout(p.timer);
    timeoutsInARow = 0;
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new MemoryHostError(msg.error ?? "the memory host failed"));
  }

  return {
    generation: () => (current && !current.dead ? generation : generation + 1),
    pid: () => (current && !current.dead ? current.proc.pid ?? null : null),

    async request(op, args, deadlineMs) {
      if (!current || current.dead) current = start();
      const run = current;
      await run.ready;
      if (run.dead) throw new MemoryHostError("the memory host exited");
      const id = nextId++;
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          run.pending.delete(id);
          reject(new MemoryHostError(`the memory host did not answer ${op} within ${deadlineMs / 1000} s`));
          if (++timeoutsInARow >= HUNG_AFTER_TIMEOUTS) {
            log.warn(`memory host pid=${run.proc.pid} missed ${timeoutsInARow} deadlines in a row; killed`);
            timeoutsInARow = 0;
            fail(run, "the memory host stopped answering");
            run.proc.kill("SIGKILL");
          }
        }, deadlineMs);
        run.pending.set(id, { resolve: resolvePromise, reject, timer });
        try {
          run.proc.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
        } catch (e) {
          clearTimeout(timer);
          run.pending.delete(id);
          reject(new MemoryHostError(`the memory host is gone: ${(e as Error).message}`));
        }
      });
    },

    setListener(fn) { listener = fn; },

    stop() {
      const run = current;
      current = null;
      if (!run) return;
      fail(run, "the memory host was stopped");
      try { run.proc.stdin.end(); } catch { /* already closed */ }
      run.proc.kill();
    },
  };
}

/** What the host needs from PPM's config, read here because the host opens neither. */
async function serverConfig(): Promise<MemoryHostConfig> {
  const { configService } = await import("../config.service.ts");
  const { listCodexAccounts } = await import("../codex-account.service.ts");
  const ai = configService.get("ai");
  const codexHomes = [join(homedir(), ".codex")];
  if (process.env.CODEX_HOME) codexHomes.push(process.env.CODEX_HOME);
  try { codexHomes.push(...listCodexAccounts().map((a) => a.home)); }
  catch (e) { log.debug(`codex accounts unavailable for memory sync: ${(e as Error).message}`); }
  return {
    ai: {
      share_provider_context: ai.share_provider_context,
      tab_tools: ai.tab_tools,
      ppm_tools: ai.ppm_tools,
      memory: ai.memory,
    },
    codexHomes,
    projects: (configService.get("projects") ?? []).map((p: { path: string }) => p.path),
  };
}

export interface MemoryHostClientOptions {
  channel?: MemoryHostChannel;
  /** The config sent to the host; the server's own by default. */
  config?: () => MemoryHostConfig | Promise<MemoryHostConfig>;
}

export function createMemoryHostClient(options: MemoryHostClientOptions = {}) {
  const channel = options.channel ?? processMemoryChannel();
  const config = options.config ?? serverConfig;
  let sent: { generation: number; json: string } | null = null;

  async function call<K extends MemoryHostOp>(
    op: K, args: MemoryHostRequests[K]["args"], deadlineMs = DEFAULT_DEADLINE_MS,
  ): Promise<MemoryHostRequests[K]["result"]> {
    const cfg = await config();
    const json = JSON.stringify(cfg);
    const generation = channel.generation();
    if (!sent || sent.generation !== generation || sent.json !== json) {
      await channel.request("configure", cfg, DEFAULT_DEADLINE_MS);
      sent = { generation: channel.generation(), json };
    }
    return (await channel.request(op, args, deadlineMs)) as MemoryHostRequests[K]["result"];
  }

  return {
    /** Syncs the project, then answers its `<ppm_memory>` block ("" for none). */
    prepareChat: (projectPath: string, providerId: string) => call("prepareChat", { projectPath, providerId }),
    syncAll: () => call("syncAll", {}, SYNC_ALL_DEADLINE_MS),
    syncStatus: (projectPath: string) => call("syncStatus", { projectPath }),
    syncStatusFile: () => call("syncStatusFile", {}),
    queueStatus: (key?: string) => call("queueStatus", key ? { key } : {}),
    kick: (key?: string) => call("kick", key ? { key } : {}),
    indexList: (keys: string[], opts: { includeArchived?: boolean } = {}) => call("indexList", { keys, ...opts }),
    callTool: (binding: MemoryToolsBinding, name: string, args: Json) => call("tool", { binding, name, args }),
    testLocal: (text: string) => call("testLocal", { text }, LOCAL_TEST_DEADLINE_MS),
    setListener: (fn: ((event: MemoryRuntimeEvent) => void) | null) => channel.setListener(fn),
    /** The running host's pid; null while none runs. */
    pid: () => channel.pid(),
    stop: () => channel.stop(),
  };
}

export type MemoryHostClient = ReturnType<typeof createMemoryHostClient>;

let shared: MemoryHostClient | null = null;

/** The server's memory host client, created on first use (the host itself starts on the first request). */
export function memoryHost(): MemoryHostClient {
  shared ??= createMemoryHostClient();
  return shared;
}

/** Replaces the shared client (tests run the host in-process); null goes back to the default. */
export function setMemoryHost(client: MemoryHostClient | null): void {
  shared = client;
}

/** Server shutdown: closes the host's stdin, and with it the host. */
export function stopMemoryHost(): void {
  shared?.stop();
}

/** The memory tools of the tab-tools MCP server, answered by the host. */
export function memoryHostTools(host: () => MemoryHostClient = memoryHost) {
  return {
    async call(binding: MemoryToolsBinding, name: string, args: Json): Promise<Json> {
      try {
        return await host().callTool(binding, name, args);
      } catch (e) {
        return textResult(`PPM memory is unavailable right now: ${(e as Error).message}`, true);
      }
    },
  };
}

/**
 * Embed everything once the local model has finished installing. The queue keeps the reason of
 * its last attempt until something kicks it again, so without this a model installed after the
 * source was chosen sat at "0 of N" with "not installed" until the next sync (2026-11-12, live).
 */
export function kickWhenInstalled(kick: () => unknown): (status: Pick<LocalInstallStatus, "state">) => void {
  let previous: LocalInstallStatus["state"] | null = null;
  return (status) => {
    if (status.state === "ready" && previous !== "ready") void kick();
    previous = status.state;
  };
}
