/**
 * Cached "read the tail of this rollout as text" for the Codex side of the
 * running-agents feed. Split out of `agent-transcript-codex-activity.ts` to
 * keep both files within the project's file-size guideline.
 *
 * The activity feed polls every 3s whether or not a descendant's rollout
 * actually changed; re-reading 256KB of an unchanged file on every one of
 * those ticks (up to 64 descendants deep) is exactly the "still cheap when
 * idle" invariant this cache exists to protect. A result is only ever
 * reused when the file's size AND mtime both still match what was read.
 */
import { statSync } from "node:fs";
import { agentTranscriptFsIo, statSizeSafe } from "./agent-transcript-fs-io.ts";

const TAIL_BYTES = 256 * 1024;
const MAX_TAIL_READ_CACHE_ENTRIES = 1000;

export function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Read the tail of a file as text, dropping a possibly-partial first line.
 * Never throws — a file that vanishes or locks up between the stat and the
 * read (this runs on a 3s ticker, unattended) degrades to "nothing read"
 * rather than reaching the caller and, through it, an un-awaited tick
 * promise with nothing to catch its rejection.
 */
function readTailText(path: string): { text: string; size: number } | null {
  const size = statSizeSafe(path);
  if (size === null) return null;
  const start = Math.max(0, size - TAIL_BYTES);
  let buf: Buffer;
  try {
    buf = agentTranscriptFsIo.readRange(path, start, size - start);
  } catch {
    return null;
  }
  const text = buf.toString("utf8");
  // A mid-file read almost always starts inside a record; `completeLines`
  // already drops an unterminated trailing line, this drops the stray
  // leading one the same way a truncated head would.
  return { text: start > 0 ? text.slice(text.indexOf("\n") + 1) : text, size };
}

interface TailReadCacheEntry {
  size: number;
  mtimeMs: number;
  result: { text: string; size: number } | null;
}
const tailReadCache = new Map<string, TailReadCacheEntry>();

function evictTailReadCacheIfOverCapacity(): void {
  if (tailReadCache.size < MAX_TAIL_READ_CACHE_ENTRIES) return;
  const oldest = tailReadCache.keys().next().value;
  if (oldest !== undefined) tailReadCache.delete(oldest);
}

/**
 * `readTailText`, but skips the 256KB read entirely when the file's size
 * and mtime match what was read on a previous tick.
 */
export function cachedReadTailText(path: string): { text: string; size: number } | null {
  const size = statSizeSafe(path);
  if (size === null) {
    tailReadCache.delete(path);
    return null;
  }
  const mtimeMs = mtimeOf(path);
  const hit = tailReadCache.get(path);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.result;
  const result = readTailText(path);
  evictTailReadCacheIfOverCapacity();
  tailReadCache.set(path, { size, mtimeMs, result });
  return result;
}

/** Test-only: forget every cached tail read. */
export function _resetCodexTailReadCache(): void {
  tailReadCache.clear();
}
