/**
 * The memory host (`ppm __memory__`): every piece of PPM memory that touches a file, the index or
 * an embedder runs here, in a process of its own, never on the server's main thread — the sync of
 * the providers' stores, the `<ppm_memory>` list, the four tools, the status counts and the
 * embedding queue (whose local model is a child of this process, not of the server).
 *
 * Protocol (JSON lines over stdio; `memory-host-client.ts` is the other end):
 *   out: {"ready":true} once, then {"id":1,"ok":true,"result":…} | {"id":1,"ok":false,"error":"…"}
 *        and {"event":<MemoryRuntimeEvent>} whenever a memory or the queue changes.
 *   in:  {"id":1,"op":"<MemoryHostOp>","args":{…}}
 * Requests run concurrently; `configure` takes effect before the next request is read.
 * The host exits when stdin closes (the server is gone).
 *
 * It reads no config and opens no database: the server sends the settings, the Codex homes and the
 * project list with `configure` (`memory-host-imports.test.ts` walks the import graph).
 */
import { createLogger, installFileLogSink } from "../logger.ts";
import { createMemoryTools, type MemoryToolsBinding } from "../tab-tools-mcp/memory-tools.ts";
import type { Json } from "../mcp-http-endpoint.ts";
import { getMemoryIndex } from "./memory-index.ts";
import { buildMemoryList } from "./memory-context.ts";
import { currentEmbedder, type MemoryAi } from "./memory-settings.ts";
import { memorySync, setMemorySyncSources } from "./memory-sync.ts";
import {
  memoryEmbedQueue, setMemoryRuntimeListener, setMemoryRuntimeSettings, type MemoryRuntimeEvent,
} from "./memory-runtime.ts";

/** Everything the host knows about PPM's config, sent by the server. */
export interface MemoryHostConfig {
  ai: MemoryAi;
  codexHomes: string[];
  projects: string[];
}

export interface MemoryHostRequests {
  configure: { args: MemoryHostConfig; result: null };
  /** Sync the project's stores, then its `<ppm_memory>` block ("" when there is nothing to list). */
  prepareChat: { args: { projectPath: string; providerId: string }; result: string };
  syncAll: { args: Record<string, never>; result: Awaited<ReturnType<typeof memorySync.syncAll>> };
  syncStatus: { args: { projectPath: string }; result: Awaited<ReturnType<typeof memorySync.status>> };
  syncStatusFile: { args: Record<string, never>; result: Awaited<ReturnType<typeof memorySync.statusFile>> };
  queueStatus: { args: { key?: string }; result: ReturnType<typeof memoryEmbedQueue.status> };
  /** Starts the queue and answers at once. */
  kick: { args: { key?: string }; result: null };
  /** Rows of the index, cut to what a status count needs. */
  indexList: { args: { keys: string[]; includeArchived?: boolean }; result: Array<{ projectKey: string; archived: boolean }> };
  tool: { args: { binding: MemoryToolsBinding; name: string; args: Json }; result: Json };
  /** Embeds one sentence with the local model: its vector's length. */
  testLocal: { args: { text: string }; result: number };
}

export type MemoryHostOp = keyof MemoryHostRequests;

const log = createLogger("memory-host");
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export type MemoryHostHandler = <K extends MemoryHostOp>(op: K, args: MemoryHostRequests[K]["args"]) => Promise<MemoryHostRequests[K]["result"]>;

/** The host's requests, events going to `emit`. Also what tests run in-process (`inProcessMemoryChannel`). */
export function createMemoryHostHandler(emit: (event: MemoryRuntimeEvent) => void): MemoryHostHandler {
  setMemoryRuntimeListener(emit);
  const tools = createMemoryTools();

  const handlers: { [K in MemoryHostOp]: (args: MemoryHostRequests[K]["args"]) => MemoryHostRequests[K]["result"] | Promise<MemoryHostRequests[K]["result"]> } = {
    configure(cfg) {
      setMemoryRuntimeSettings(cfg.ai);
      setMemorySyncSources({ codexHomes: cfg.codexHomes, projects: cfg.projects });
      return null;
    },
    async prepareChat({ projectPath, providerId }) {
      // A failing sync never stops the message: it goes out with whatever list there is.
      try { await memorySync.ensureSynced(projectPath); }
      catch (e) { log.warn(`memory sync of ${projectPath} failed, listing what there is: ${errorText(e)}`); }
      return buildMemoryList(projectPath, providerId);
    },
    syncAll: () => memorySync.syncAll(),
    syncStatus: ({ projectPath }) => memorySync.status(projectPath),
    syncStatusFile: () => memorySync.statusFile(),
    queueStatus: ({ key }) => memoryEmbedQueue.status(key),
    kick({ key }) {
      void memoryEmbedQueue.kick(key);
      return null;
    },
    indexList: ({ keys, includeArchived }) =>
      getMemoryIndex().list(keys, { includeArchived }).map((r) => ({ projectKey: r.projectKey, archived: r.archived })),
    tool: ({ binding, name, args }) => tools.call(binding, name, args),
    async testLocal({ text }) {
      const embedder = currentEmbedder({ memory: { embedding: { source: "local" } } });
      if (!embedder) throw new Error("The local model is not available");
      const [vector] = await embedder.embed([text], "query");
      return vector?.length ?? 0;
    },
  };

  return async (op, args) => {
    const fn = handlers[op] as ((a: unknown) => unknown) | undefined;
    if (!fn) throw new Error(`Unknown memory host request: ${String(op)}`);
    return (await fn(args)) as never;
  };
}

/** One write then one flush per line (a `FileSink`'s return value is not progress). */
function stdoutLines(): (message: unknown) => void {
  const sink = Bun.stdout.writer();
  return (message) => {
    sink.write(`${JSON.stringify(message)}\n`);
    void sink.flush();
  };
}

export async function main(): Promise<void> {
  // stdout is the protocol: every console call goes to ppm.log instead (the echo to stderr is
  // skipped where stderr already is ppm.log, as it is under the supervisor).
  installFileLogSink({ echo: "stderr", routeConsole: true });
  const send = stdoutLines();
  const handle = createMemoryHostHandler((event) => send({ event }));
  send({ ready: true });

  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let message: { id?: unknown; op?: unknown; args?: unknown };
        try { message = JSON.parse(line); } catch { log.warn("malformed request line, ignored"); continue; }
        const id = message.id;
        if (typeof id !== "number" || typeof message.op !== "string") continue;
        handle(message.op as MemoryHostOp, (message.args ?? {}) as never).then(
          (result) => send({ id, ok: true, result: result ?? null }),
          (error) => send({ id, ok: false, error: errorText(error) }),
        );
      }
    }
  } catch (error) {
    log.error(`stdin failed: ${errorText(error)}`);
  }
  // stdin closed: the server is gone. A local model host is our child and sees its own stdin close.
  process.exit(0);
}

/**
 * The host's handler behind the client's channel interface, in this process: what tests use to
 * run the real host code without spawning it. Every message goes through JSON, as on the pipe.
 * Never used by the server — a host that cannot start is an error there, not a fallback.
 */
export function inProcessMemoryChannel() {
  let listener: ((event: MemoryRuntimeEvent) => void) | null = null;
  const handle = createMemoryHostHandler((event) => listener?.(JSON.parse(JSON.stringify(event))));
  return {
    generation: () => 1,
    pid: () => null,
    async request(op: string, args: unknown): Promise<unknown> {
      const result = await handle(op as MemoryHostOp, JSON.parse(JSON.stringify(args ?? {})));
      return JSON.parse(JSON.stringify(result ?? null));
    },
    setListener(fn: ((event: MemoryRuntimeEvent) => void) | null) { listener = fn; },
    stop() {},
  };
}
