/**
 * `/api/memory` — PPM's shared memory in Settings (behind auth): what the store holds and where it
 * came from, Sync now, the on/off switch and the embedding source, and the local model's install.
 * The embedding key is a secret: it is saved here but never answered, only `has_api_key` (9.3),
 * and an endpoint error that echoes it back has it masked.
 *
 * Every count, sync and embedding is asked of the memory host (`memory-host-client.ts`), a
 * process of its own; a host that does not answer is a 503. `wireMemoryEvents` points the host's
 * events and the installer at `/ws/global` (`memory:changed`, `memory:embed-install`); the server
 * calls it once where it mounts this.
 */
import { Hono, type Context } from "hono";
import { ok, err } from "../../types/api.ts";
import { broadcastGlobalEvent } from "../ws/global.ts";
import { configService } from "../../services/config.service.ts";
import { resolveProjectPath } from "../helpers/resolve-project.ts";
import type { MemoryConfig, MemoryEmbeddingConfig, MemoryEmbeddingSource } from "../../types/config.ts";
import { memoryEnabled, publicMemorySettings } from "../../services/memory/memory-settings.ts";
import type { MemorySync } from "../../services/memory/memory-sync.ts";
import { localInstaller, type LocalInstaller, type LocalInstallStatus } from "../../services/memory/embedding/local-install.ts";
import { kickWhenInstalled, memoryHost, type MemoryHostClient } from "../../services/memory/memory-host-client.ts";
import { createLogger } from "../../services/logger.ts";
import type { EmbedQueueStatus } from "../../services/memory/embedding/embed-queue.ts";
import { EMBEDDING_OFF_REASON } from "../../services/memory/embedding/embedder.ts";
import { GLOBAL_MEMORY_KEY } from "../../services/memory/memory-index.ts";
import { memoryRoot, projectMemoryKey } from "../../services/memory/memory-paths.ts";
import { ApiEmbedder } from "../../services/memory/embedding/api-embedder.ts";

export const MEMORY_CHANGED_EVENT = "memory:changed";
export const MEMORY_EMBED_INSTALL_EVENT = "memory:embed-install";

const SOURCES: readonly MemoryEmbeddingSource[] = ["off", "local", "api"];
const TEST_SENTENCE = "PPM keeps memories that every provider can read.";
/** The local embedder has no timeout of its own; a test answers within this. */
const LOCAL_TEST_TIMEOUT_MS = 60_000;
const NOT_INSTALLED = "The local model is not installed";
const log = createLogger("memory");

type Awaitable<T> = T | Promise<T>;

/** What the routes need from the memory host; tests fake each part. */
export interface MemoryRouteDeps {
  broadcast?: (event: unknown) => void;
  sync?: { [K in "syncAll" | "status" | "statusFile"]: (...args: Parameters<MemorySync[K]>) => Awaitable<Awaited<ReturnType<MemorySync[K]>>> };
  installer?: Pick<LocalInstaller, "status" | "install" | "uninstall">;
  queue?: { status(key?: string): Awaitable<EmbedQueueStatus>; kick(key?: string): unknown };
  index?: () => { list(keys: string[], opts: { includeArchived?: boolean }): Awaitable<Array<{ projectKey: string; archived: boolean }>> };
  /** Embeds one sentence with the local model, answering the vector's length. */
  localTest?: (text: string) => Promise<number>;
}

/** The memory host behind the routes' deps: every count, sync and embedding runs in that process. */
function hostDeps(host: () => MemoryHostClient = memoryHost): Required<Pick<MemoryRouteDeps, "sync" | "queue" | "index" | "localTest">> {
  return {
    sync: {
      syncAll: () => host().syncAll(),
      status: (projectPath) => host().syncStatus(projectPath),
      statusFile: () => host().syncStatusFile(),
    },
    queue: { status: (key) => host().queueStatus(key), kick: (key) => host().kick(key) },
    index: () => ({ list: (keys, opts) => host().indexList(keys, opts) }),
    localTest: (text) => host().testLocal(text),
  };
}

/**
 * Points memory changes, queue progress and install progress at `/ws/global`, and starts the
 * embedding queue once the local model is installed. Returns an undo.
 */
export function wireMemoryEvents(
  broadcast: (event: unknown) => void = broadcastGlobalEvent,
  installer: Pick<LocalInstaller, "subscribe"> = localInstaller(),
  host: Pick<MemoryHostClient, "setListener" | "kick"> = memoryHost(),
): () => void {
  host.setListener((event) => {
    if (event.kind === "changed") broadcast({ type: MEMORY_CHANGED_EVENT, ...event.change });
    else broadcast({ type: MEMORY_CHANGED_EVENT, embedding: event.status });
  });
  const onInstall = kickWhenInstalled(() => host.kick().catch((e: unknown) => {
    log.warn(`could not start embedding after the local model installed: ${(e as Error).message}`);
  }));
  const unsubscribe = installer.subscribe((status) => {
    broadcast({ type: MEMORY_EMBED_INSTALL_EVENT, status });
    onInstall(status);
  });
  return () => {
    host.setListener(null);
    unsubscribe();
  };
}

type Fields = Partial<Record<"source" | "api_url" | "api_model" | "api_key", unknown>>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `fields` laid over the stored embedding settings, or an error. A missing or empty `api_key`
 * keeps the stored key; an API source needs an http(s) URL and a model.
 */
function mergeEmbedding(stored: MemoryEmbeddingConfig | undefined, fields: Fields): MemoryEmbeddingConfig | string {
  const next: MemoryEmbeddingConfig = { ...stored, source: stored?.source ?? "off" };
  if (fields.source !== undefined) {
    if (!SOURCES.includes(fields.source as MemoryEmbeddingSource)) return 'source must be "off", "local" or "api"';
    next.source = fields.source as MemoryEmbeddingSource;
  }
  for (const key of ["api_url", "api_model", "api_key"] as const) {
    const value = fields[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return `${key} must be a string`;
    const trimmed = value.trim();
    if (key === "api_key" && !trimmed) continue;
    next[key] = trimmed;
  }
  if (next.api_url) {
    let protocol = "";
    try { protocol = new URL(next.api_url).protocol; } catch { /* not a URL */ }
    if (protocol !== "http:" && protocol !== "https:") return "api_url must be an http(s) URL";
  }
  if (next.source === "api" && (!next.api_url || !next.api_model)) return "An API source needs a URL and a model";
  return next;
}

/** A JSON body as an object; an empty body is `{}` when `optional`. */
async function readObject(c: Context, optional: boolean): Promise<Record<string, unknown> | null> {
  const text = await c.req.text();
  if (!text.trim() && optional) return {};
  try {
    const body = JSON.parse(text);
    return isObject(body) ? body : null;
  } catch {
    return null;
  }
}

/** `message` with every given secret replaced, so an endpoint echoing a key cannot leak it. */
function mask(message: string, secrets: Array<string | undefined>): string {
  let out = message;
  for (const s of secrets) if (s) out = out.split(s).join("[REDACTED]");
  return out;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer from the local model after ${ms / 1000} s`)), ms);
  });
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Whether the source can make vectors now, and why not. */
function readiness(emb: MemoryEmbeddingConfig | undefined, install: LocalInstallStatus, queueReason: string | null) {
  const source = emb?.source ?? "off";
  if (source === "off") return { ready: false, reason: queueReason ?? EMBEDDING_OFF_REASON };
  if (source === "local") {
    if (install.state === "ready") return { ready: true, reason: queueReason };
    if (install.state === "failed") return { ready: false, reason: `The local model failed to install: ${install.reason}` };
    if (install.state === "installing") return { ready: false, reason: "The local model is installing" };
    return { ready: false, reason: NOT_INSTALLED };
  }
  if (!emb?.api_url || !emb.api_model) return { ready: false, reason: "An API source needs a URL and a model" };
  return { ready: true, reason: queueReason };
}

export function createMemoryRoutes(deps: MemoryRouteDeps = {}): Hono {
  const broadcast = deps.broadcast ?? broadcastGlobalEvent;
  const host = hostDeps();
  const sync = deps.sync ?? host.sync;
  const installer = deps.installer ?? localInstaller();
  const queue = deps.queue ?? host.queue;
  const index = deps.index ?? host.index;
  const localTest = deps.localTest ?? host.localTest;
  const routes = new Hono();
  const unavailable = (c: Context, e: unknown) => c.json(err(`PPM memory is unavailable right now: ${(e as Error).message}`), 503);

  routes.get("/status", async (c) => {
    const project = c.req.query("project");
    let projectPath: string | null = null;
    if (project) {
      try { projectPath = resolveProjectPath(project); } catch (e) { return c.json(err((e as Error).message), 404); }
    }
    const ai = configService.get("ai");
    const key = projectPath ? projectMemoryKey(projectPath) : null;

    let rows: Array<{ projectKey: string; archived: boolean }>;
    let providers: Awaited<ReturnType<MemorySync["status"]>>;
    let queueStatus: EmbedQueueStatus;
    try {
      [rows, providers, queueStatus] = await Promise.all([
        index().list(key ? [key, GLOBAL_MEMORY_KEY] : [GLOBAL_MEMORY_KEY], { includeArchived: true }),
        projectPath ? sync.status(projectPath) : Promise.resolve(sync.statusFile()).then((f) => f.providers),
        queue.status(key ?? undefined),
      ]);
    } catch (e) {
      return unavailable(c, e);
    }
    const counts = { project: 0, global: 0, archived: 0 };
    for (const row of rows) {
      if (row.archived) counts.archived++;
      else if (row.projectKey === GLOBAL_MEMORY_KEY) counts.global++;
      else counts.project++;
    }

    const install = installer.status();
    const settings = publicMemorySettings(ai);
    return c.json(ok({
      enabled: settings.enabled,
      root: memoryRoot(),
      counts,
      providers,
      embedding: {
        ...settings.embedding,
        model: queueStatus.model,
        ...readiness(ai.memory?.embedding, install, queueStatus.reason),
        vectors: queueStatus.vectors,
        total: queueStatus.total,
        running: queueStatus.running,
        install,
      },
    }));
  });

  routes.post("/sync", async (c) => {
    if (!memoryEnabled(configService.get("ai"))) return c.json(err("PPM memory is off"), 409);
    try {
      return c.json(ok({ results: await sync.syncAll() }));
    } catch (e) {
      return unavailable(c, e);
    }
  });

  routes.put("/settings", async (c) => {
    const body = await readObject(c, false);
    if (!body) return c.json(err("Expected a JSON object"), 400);
    const ai = configService.get("ai");
    const next: MemoryConfig = { ...ai.memory };
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") return c.json(err("enabled must be a boolean"), 400);
      next.enabled = body.enabled;
    }
    if (body.embedding !== undefined) {
      if (!isObject(body.embedding)) return c.json(err("embedding must be an object"), 400);
      const merged = mergeEmbedding(ai.memory?.embedding, body.embedding);
      if (typeof merged === "string") return c.json(err(merged), 400);
      next.embedding = merged;
    }
    const updated = { ...ai, memory: next };
    configService.set("ai", updated);
    configService.save();

    const settings = publicMemorySettings(updated);
    // A new source or model: the queue drops the old model's vectors and embeds with the new one.
    if (settings.enabled && (body.embedding !== undefined || body.enabled === true)) {
      Promise.resolve(queue.kick()).catch((e: unknown) => log.warn(`could not start embedding: ${(e as Error).message}`));
    }
    broadcast({ type: MEMORY_CHANGED_EVENT, settings });
    return c.json(ok(settings));
  });

  routes.post("/embedding/install", (c) => {
    void installer.install(); // never rejects; progress goes out as memory:embed-install
    return c.json(ok(installer.status()));
  });

  routes.delete("/embedding/install", async (c) => {
    await installer.uninstall(); // stops a running install too
    return c.json(ok(installer.status()));
  });

  routes.post("/embedding/test", async (c) => {
    const body = await readObject(c, true);
    if (!body) return c.json(err("Expected a JSON object"), 400);
    const ai = configService.get("ai");
    const emb = mergeEmbedding(ai.memory?.embedding, body);
    if (typeof emb === "string") return c.json(err(emb), 400);
    if (emb.source === "off") return c.json(err("Choose Local model or API to test"), 400);

    if (emb.source === "local" && installer.status().state !== "ready") return c.json(ok({ ok: false, error: NOT_INSTALLED }));

    const started = performance.now();
    try {
      // An API is one HTTP request from here; the local model runs under the memory host, which
      // keeps the one warm copy the queue uses too.
      const dims = emb.source === "api"
        ? (await new ApiEmbedder({ url: emb.api_url!, model: emb.api_model!, apiKey: emb.api_key || undefined })
          .embed([TEST_SENTENCE], "query"))[0]?.length ?? 0
        : await withTimeout(localTest(TEST_SENTENCE), LOCAL_TEST_TIMEOUT_MS);
      return c.json(ok({ ok: true, dims, ms: Math.round(performance.now() - started) }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json(ok({ ok: false, error: mask(message, [emb.api_key, ai.memory?.embedding?.api_key]) }));
    }
  });

  return routes;
}

export const memoryRoutes = createMemoryRoutes();
