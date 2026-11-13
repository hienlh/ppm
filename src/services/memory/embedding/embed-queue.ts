/**
 * The background embedding queue (8.4, 8.5, 9.4). After a reconcile it finds the active
 * memories with no vector for the current model, or one of an older revision, and embeds them
 * in batches of 16, one batch at a time. The embedder does the work out of process (the local
 * host or an API); this only awaits it, with a timeout of its own per batch because the local
 * embedder has none. A failure is kept as the reason Settings shows and retried on the next kick.
 * A model change deletes the previous model's vectors, so two models are never mixed.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "../../logger.ts";
import { parseMemoryFile } from "../memory-file.ts";
import { GLOBAL_MEMORY_KEY, getMemoryIndex, type MemoryIndex, type MemoryIndexRow } from "../memory-index.ts";
import { EMBED_BATCH_SIZE, EMBEDDING_OFF_REASON, type Embedder } from "./embedder.ts";

const log = createLogger("memory-embed-queue");

/** How long one batch may take before it counts as a failure. */
export const EMBED_BATCH_TIMEOUT_MS = 60_000;

export { EMBEDDING_OFF_REASON };

/** Beside the index: the model the stored vectors were computed with, so a restart sees a change. */
const MODEL_FILE = "embed-model.json";

export interface EmbedQueueStatus {
  /** The current embedder's model, null when none is configured. */
  model: string | null;
  /** Active memories with a vector of the current model and revision. */
  vectors: number;
  /** Active memories. */
  total: number;
  running: boolean;
  /** Why vectors are missing (no source, the last failure), null after a clean run. */
  reason: string | null;
}

export interface EmbedQueueOptions {
  /** The embedder of the current settings, null when the source is Off. */
  embedder: () => Embedder | null;
  index?: () => MemoryIndex;
  timeoutMs?: number;
  onChange?: (status: EmbedQueueStatus) => void;
}

export interface EmbedQueue {
  /**
   * Embeds what is missing for one project (plus the global memories), or for every folder when
   * no key is given. Resolves once the queue has nothing left; never rejects.
   */
  kick(projectKey?: string): Promise<void>;
  /** Counts for one project (plus global), or for every folder. */
  status(projectKey?: string): EmbedQueueStatus;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const rowKey = (r: { projectKey: string; id: string }) => `${r.projectKey}\0${r.id}`;
const yieldToLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const label = ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`embedding timed out after ${label}`)), ms);
  });
  work.catch(() => undefined); // a batch that lost the race must not surface as unhandled
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function createEmbedQueue(opts: EmbedQueueOptions): EmbedQueue {
  const index = opts.index ?? getMemoryIndex;
  const timeoutMs = opts.timeoutMs ?? EMBED_BATCH_TIMEOUT_MS;
  let reason: string | null = null;
  let running = false;
  /** Keys asked for since the current pass started; "all" when a kick named no project. */
  let pending: Set<string> | "all" | null = null;
  let loop: Promise<void> | null = null;

  /** The configured embedder, or the error building it (a bad setting) as text. */
  const currentEmbedder = (): { embedder: Embedder | null; error?: string } => {
    try {
      return { embedder: opts.embedder() };
    } catch (err) {
      return { embedder: null, error: errorText(err) };
    }
  };

  function keysFor(projectKey?: string): string[] {
    if (projectKey) return projectKey === GLOBAL_MEMORY_KEY ? [GLOBAL_MEMORY_KEY] : [projectKey, GLOBAL_MEMORY_KEY];
    const keys = [GLOBAL_MEMORY_KEY];
    try {
      for (const e of readdirSync(join(dirname(index().path), "projects"), { withFileTypes: true })) {
        if (e.isDirectory()) keys.push(e.name);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return keys;
  }

  function status(projectKey?: string): EmbedQueueStatus {
    const idx = index();
    const keys = keysFor(projectKey);
    const rows = idx.list(keys);
    const { embedder, error } = currentEmbedder();
    const model = embedder?.model ?? null;
    let vectors = 0;
    if (model) {
      const have = new Map(idx.getVectors(keys, model).map((v) => [rowKey(v), v.revision]));
      vectors = rows.filter((r) => have.get(rowKey(r)) === r.revision).length;
    }
    return { model, vectors, total: rows.length, running, reason: embedder ? reason : (error ?? EMBEDDING_OFF_REASON) };
  }

  function emit(projectKey?: string): void {
    if (!opts.onChange) return;
    try {
      opts.onChange(status(projectKey));
    } catch (err) {
      log.warn(`embed queue onChange failed: ${errorText(err)}`);
    }
  }

  function setReason(next: string | null): void {
    if (next && next !== reason) log.warn(`memory embedding: ${next}`);
    reason = next;
  }

  /** Deletes the vectors of the model recorded beside the index when it is not `model`. */
  function adoptModel(idx: MemoryIndex, model: string): void {
    const file = join(dirname(idx.path), MODEL_FILE);
    let previous: string | null = null;
    if (existsSync(file)) {
      try {
        previous = (JSON.parse(readFileSync(file, "utf8")) as { model?: string }).model ?? null;
      } catch {
        previous = null;
      }
    }
    if (previous === model) return;
    if (previous) {
      const removed = idx.deleteVectorsByModel(previous);
      log.info(`memory embedding model changed from ${previous} to ${model}; dropped ${removed} vectors`);
    }
    writeFileSync(file, `${JSON.stringify({ model })}\n`);
  }

  /** The text a memory is embedded as, or null when its file is gone or moved past the row. */
  async function passage(row: MemoryIndexRow): Promise<string | null> {
    let text: string;
    try {
      text = await readFile(row.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const m = parseMemoryFile(text, row.id, row.scope);
    if (m.revision !== row.revision) return null; // changed since the reconcile; the next one brings it
    return `${m.name}\n${m.description}\n\n${m.body}`.trim();
  }

  async function runOnce(keys: string[]): Promise<void> {
    const { embedder, error } = currentEmbedder();
    if (!embedder) {
      if (error) setReason(error);
      else reason = EMBEDDING_OFF_REASON;
      return;
    }
    try {
      const idx = index();
      const model = embedder.model;
      adoptModel(idx, model);
      const have = new Map(idx.getVectors(keys, model).map((v) => [rowKey(v), v.revision]));
      const todo = idx.list(keys).filter((r) => have.get(rowKey(r)) !== r.revision);
      for (let i = 0; i < todo.length; i += EMBED_BATCH_SIZE) {
        const items: { row: MemoryIndexRow; text: string }[] = [];
        for (const row of todo.slice(i, i + EMBED_BATCH_SIZE)) {
          const text = await passage(row);
          if (text !== null) items.push({ row, text });
        }
        if (!items.length) continue;
        const vectors = await withTimeout(embedder.embed(items.map((t) => t.text), "passage"), timeoutMs);
        if (!Array.isArray(vectors) || vectors.length !== items.length) {
          throw new Error(`embedding source answered ${Array.isArray(vectors) ? vectors.length : 0} vectors for ${items.length} texts`);
        }
        items.forEach(({ row }, j) => {
          idx.putVector({ id: row.id, scope: row.scope, projectKey: row.projectKey, model, revision: row.revision, vector: vectors[j]! });
        });
        emit();
        await yieldToLoop();
      }
      setReason(null);
    } catch (err) {
      setReason(errorText(err));
    }
  }

  async function drain(): Promise<void> {
    running = true;
    emit();
    try {
      while (pending) {
        const asked = pending;
        pending = null;
        try {
          await runOnce(asked === "all" ? keysFor() : [...asked]);
        } catch (err) {
          setReason(errorText(err));
        }
      }
    } finally {
      running = false;
      loop = null;
      emit();
    }
  }

  function kick(projectKey?: string): Promise<void> {
    if (!projectKey || pending === "all") pending = "all";
    else {
      pending ??= new Set();
      for (const k of keysFor(projectKey)) pending.add(k);
    }
    loop ??= drain();
    return loop;
  }

  return { kick, status };
}
