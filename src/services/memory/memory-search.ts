/**
 * Memory search: full-text (bm25 relative to the top hit) fused with the cosine similarity of
 * current-model vectors as `max(v, f) + 0.3 × min(v, f)`, a missing side counting 0. That score
 * only ranks: the top text hit is 1.0 whatever it matched, and e5 similarities sit in a 0.75–0.85
 * band, so a query nothing answers scored like one that was answered (1.24 vs 1.23, measured).
 *
 * Whether a result really matches is a separate label, `match`, from two signals that do separate
 * them (measured on 109 real memories, 12 answered and 8 unanswerable queries):
 * - the query's words it holds, weighted by rarity (`MemoryIndex.coverage`): the best result of
 *   every answered query held ≥ 0.33, of every unanswerable one ≤ 0.07;
 * - how far its similarity stands above the store's for this query (z-score): an answer found by
 *   meaning alone stood at 4–6, nothing unanswerable above 3.44.
 * Strong results come first. When the query cannot be embedded (no source, an error, or no answer
 * within 3 s) the answer is text only and says why (8.2, 8.3). Archived memories never appear (2.3).
 */
import type { Embedder } from "./embedding/embedder.ts";
import { getMemoryIndex, GLOBAL_MEMORY_KEY, type MemoryIndexRow } from "./memory-index.ts";
import { projectMemoryKey } from "./memory-paths.ts";
import type { MemoryScope, MemorySource } from "./memory-types.ts";

/** How long the query's vector may take before the search answers by text alone. */
export const QUERY_EMBED_TIMEOUT_MS = 3_000;
/** Share of the query's (rarity-weighted) words a memory must hold to match on words. */
export const STRONG_COVERAGE = 0.3;
/** How many standard deviations above the store's similarity a memory must stand to match on meaning. */
export const STRONG_Z = 4;
/** Below this many vectors a z-score says nothing; meaning alone then never makes a strong match. */
export const MIN_VECTORS_FOR_Z = 20;

export interface MemorySearchOptions {
  /** The project whose memories are searched besides the global ones; without it, global only. */
  projectPath?: string;
  query: string;
  scope?: "project" | "global" | "all";
  limit?: number;
}

export interface MemorySearchDeps {
  /** The configured embedding source, or null when there is none. */
  embedder: () => Embedder | null;
  /** Overrides `QUERY_EMBED_TIMEOUT_MS` (tests). */
  timeoutMs?: number;
}

export interface MemorySearchResult {
  id: string;
  scope: MemoryScope;
  name: string;
  description: string;
  source: MemorySource;
  score: number;
  /** strong: it holds enough of the query's words, or stands out by meaning; weak: only the closest there was. */
  match: "strong" | "weak";
}

export interface MemorySearchResponse {
  mode: "hybrid" | "text";
  /** Why the search ran by text only. */
  reason?: string;
  results: MemorySearchResult[];
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The query's vector, or why there is none. Never waits past `timeoutMs`. */
async function embedQuery(
  embedder: Embedder | null,
  query: string,
  timeoutMs: number,
): Promise<{ vector: Float32Array } | { reason: string }> {
  if (!embedder) return { reason: "no embedding source is configured" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ reason: string }>((resolve) => {
    timer = setTimeout(() => resolve({ reason: `embedding the query timed out after ${timeoutMs / 1000} s` }), timeoutMs);
  });
  const embedded = embedder.embed([query], "query").then(
    (vectors) => (vectors[0]?.length ? { vector: vectors[0] } : { reason: "embedding the query returned no vector" }),
    (err) => ({ reason: `embedding the query failed: ${err instanceof Error ? err.message : String(err)}` }),
  );
  try {
    return await Promise.race([embedded, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const rowKey = (projectKey: string, id: string) => `${projectKey}\u0000${id}`;

/** Each similarity as standard deviations above the mean of all of them; none when too few to say. */
function zScores(sim: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  if (sim.size < MIN_VECTORS_FOR_Z) return out;
  let mean = 0;
  for (const s of sim.values()) mean += s;
  mean /= sim.size;
  let variance = 0;
  for (const s of sim.values()) variance += (s - mean) ** 2;
  const sd = Math.sqrt(variance / sim.size);
  if (!sd) return out;
  for (const [k, s] of sim) out.set(k, (s - mean) / sd);
  return out;
}

export async function search(opts: MemorySearchOptions, deps: MemorySearchDeps): Promise<MemorySearchResponse> {
  const scope = opts.scope ?? "all";
  const limit = opts.limit ?? 10;
  const keys: string[] = [];
  if (opts.projectPath && scope !== "global") keys.push(projectMemoryKey(opts.projectPath));
  if (scope !== "project") keys.push(GLOBAL_MEMORY_KEY);

  const index = getMemoryIndex();
  const rows = new Map<string, MemoryIndexRow>();
  for (const r of index.list(keys)) rows.set(rowKey(r.projectKey, r.id), r);

  const text = new Map<string, number>();
  for (const h of index.textSearch(opts.query, keys, rows.size)) text.set(rowKey(h.projectKey, h.id), h.score);

  const embedder = deps.embedder();
  const q = await embedQuery(embedder, opts.query, deps.timeoutMs ?? QUERY_EMBED_TIMEOUT_MS);

  const coverage = new Map<string, number>();
  for (const c of index.coverage(opts.query, keys)) coverage.set(rowKey(c.projectKey, c.id), c.coverage);

  const scored: { row: MemoryIndexRow; score: number; strong: boolean }[] = [];
  const strongByWords = (k: string) => (coverage.get(k) ?? 0) >= STRONG_COVERAGE;
  if ("vector" in q && embedder) {
    const sim = new Map<string, number>();
    for (const v of index.getVectors(keys, embedder.model)) {
      const k = rowKey(v.projectKey, v.id);
      const row = rows.get(k);
      // Only a current vector counts: archived and stale-revision ones are skipped.
      if (!row || row.revision !== v.revision || v.vector.length !== q.vector.length) continue;
      sim.set(k, cosine(q.vector, v.vector));
    }
    const standsOut = zScores(sim);
    for (const [k, row] of rows) {
      if (!text.has(k) && !sim.has(k)) continue;
      const v = sim.get(k) ?? 0;
      const f = text.get(k) ?? 0;
      const z = standsOut.get(k);
      scored.push({ row, score: Math.max(v, f) + 0.3 * Math.min(v, f), strong: strongByWords(k) || (z !== undefined && z >= STRONG_Z) });
    }
  } else {
    for (const [k, f] of text) {
      const row = rows.get(k);
      if (row) scored.push({ row, score: f, strong: strongByWords(k) });
    }
  }

  scored.sort((a, b) => Number(b.strong) - Number(a.strong) || b.score - a.score);
  const results = scored.slice(0, Math.max(0, limit)).map(({ row, score, strong }) => ({
    id: row.id,
    scope: row.scope,
    name: row.name,
    description: row.description,
    source: row.source,
    score,
    match: strong ? "strong" as const : "weak" as const,
  }));
  return "vector" in q ? { mode: "hybrid", results } : { mode: "text", reason: q.reason, results };
}
