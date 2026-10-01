/**
 * Codex side of the running-agents feed: which threads the session has spawned,
 * and what each was last doing — read from bounded tails, not full parses.
 *
 * A direct child's spawn/completion is recorded as a `SubAgentActivity` item
 * in the ROOT session's own rollout (not in the child's file), so discovering
 * "what has this session spawned" means reading a slice of the root rollout
 * itself. A grandchild's spawn is recorded the same way, but inside the
 * child's own rollout — so once a child is known, its tail is read the same
 * way to find further descendants, bounded in both count and depth so a
 * runaway spawn loop cannot make this unbounded work.
 */
import { dirname } from "node:path";
import { cachedReadTailText, mtimeOf } from "./agent-transcript-codex-tail-cache.ts";
import { agentTranscriptClock } from "./agent-transcript-hub-clock.ts";
import { completeLines, parseLine } from "../../providers/codex-app-server/codex-rollout-header.ts";
import { parseSubagentActivity } from "../../providers/codex-app-server/codex-subagent-thread.ts";
import { mapRolloutItem } from "../../providers/codex-app-server/codex-rollout-items.ts";
import { findRolloutByThreadId, isCodexRolloutPath } from "../../providers/codex-app-server/codex-history.ts";
import { INDEX_REFRESH_MS } from "../../shared/agent-transcript-protocol.ts";

/** How many spawn levels deep the descendant scan follows before giving up. */
const MAX_DESCENDANT_DEPTH = 8;
/** Hard cap so a runaway spawn loop cannot make this scan unbounded. */
const MAX_DESCENDANTS = 64;

/**
 * `findRolloutByThreadId` walks every rollout under a dir with a recursive
 * `readdirSync` — fine for a one-off lookup, not for one per descendant on a
 * 3s activity tick with a thousand-rollout `~/.codex/sessions`. Cached by
 * (dir, threadId) for the same window the index cache uses elsewhere, and a
 * miss is cached too so a thread that never resolves doesn't re-scan forever.
 */
const FILE_LOOKUP_TTL_MS = INDEX_REFRESH_MS;
const MAX_LOOKUP_CACHE_ENTRIES = 1000;
interface LookupEntry { expiresAt: number; file: string | null; }
const lookupCache = new Map<string, LookupEntry>();

function evictLookupCacheIfOverCapacity(now: number): void {
  if (lookupCache.size < MAX_LOOKUP_CACHE_ENTRIES) return;
  for (const [key, entry] of lookupCache) {
    if (entry.expiresAt <= now) lookupCache.delete(key);
  }
  while (lookupCache.size >= MAX_LOOKUP_CACHE_ENTRIES) {
    const oldest = lookupCache.keys().next().value;
    if (oldest === undefined) break;
    lookupCache.delete(oldest);
  }
}

function cachedFindRolloutByThreadId(dir: string, threadId: string, projectPath: string): string | null {
  const now = agentTranscriptClock.now();
  const key = `${dir}\0${threadId}`;
  const hit = lookupCache.get(key);
  if (hit && hit.expiresAt > now) return hit.file;
  evictLookupCacheIfOverCapacity(now);
  const file = findRolloutByThreadId(dir, threadId, projectPath);
  lookupCache.set(key, { expiresAt: now + FILE_LOOKUP_TTL_MS, file });
  return file;
}

/** Test-only: forget every cached lookup. */
export function _resetCodexDescendantLookupCache(): void {
  lookupCache.clear();
}

export interface CodexDescendant {
  threadId: string;
  path: string;
  done: boolean;
  lastWriteAt: number;
  lastStep?: string;
}

/** A short, one-line label for the most recent tool call in a tail of rollout records. */
function lastStepFromLines(lines: string[]): string | undefined {
  let label: string | undefined;
  for (const line of lines) {
    const rec = parseLine(line);
    if (!rec || rec.type !== "event_msg") continue;
    const p = rec.payload ?? {};
    if (p.type !== "item_completed") continue;
    const mapped = mapRolloutItem(p.item);
    if (mapped.kind !== "events") continue;
    for (const ev of mapped.events) {
      if (ev.type === "tool_use") label = ev.tool;
      else if (ev.type === "text" && ev.content.trim()) label = ev.content.trim().split("\n")[0]!.slice(0, 160);
    }
  }
  return label;
}

/** `SubAgentActivity` items in a tail of rollout records, most-recent state per thread. */
function subagentActivityFromLines(lines: string[]): Map<string, boolean> {
  const byThread = new Map<string, boolean>();
  for (const line of lines) {
    const rec = parseLine(line);
    if (!rec || rec.type !== "event_msg") continue;
    const p = rec.payload ?? {};
    if (p.type !== "item_completed") continue;
    const activity = parseSubagentActivity(p.item);
    if (activity) byThread.set(activity.threadId, activity.done);
  }
  return byThread;
}

/**
 * Descendant threads of one rollout file (direct children when `rolloutPath`
 * is the session's own root, grandchildren when it is an already-known
 * child), each resolved to its own file and last-write time.
 */
function directDescendants(rolloutPath: string, dirs: string[], projectPath: string): CodexDescendant[] {
  const tail = cachedReadTailText(rolloutPath);
  if (!tail) return [];
  const lines = completeLines(tail.text);
  const activity = subagentActivityFromLines(lines);
  const out: CodexDescendant[] = [];
  // A child almost always lands in the same spawn-day folder as the rollout
  // that spawned it — trying that folder first turns the common case into a
  // readdir of a few dozen files instead of the whole sessions tree, with the
  // full dir list (each itself cached) still there as a fallback.
  const searchDirs = [dirname(rolloutPath), ...dirs];
  for (const [threadId, done] of activity) {
    let file: string | null = null;
    for (const dir of searchDirs) {
      const found = cachedFindRolloutByThreadId(dir, threadId, projectPath);
      if (found && isCodexRolloutPath(found)) { file = found; break; }
    }
    if (!file) continue;
    const childTail = cachedReadTailText(file);
    out.push({
      threadId,
      path: file,
      done,
      lastWriteAt: mtimeOf(file),
      lastStep: childTail ? lastStepFromLines(completeLines(childTail.text)) : undefined,
    });
  }
  return out;
}

/**
 * Every descendant of `rootRolloutPath`, discovered breadth-first up to
 * `MAX_DESCENDANT_DEPTH` levels and `MAX_DESCENDANTS` total threads.
 */
export function scanCodexDescendants(rootRolloutPath: string, dirs: string[], projectPath: string): CodexDescendant[] {
  const seen = new Map<string, CodexDescendant>();
  let frontier = [rootRolloutPath];
  for (let depth = 0; depth < MAX_DESCENDANT_DEPTH && frontier.length > 0 && seen.size < MAX_DESCENDANTS; depth++) {
    const next: string[] = [];
    for (const path of frontier) {
      for (const d of directDescendants(path, dirs, projectPath)) {
        if (seen.has(d.threadId) || seen.size >= MAX_DESCENDANTS) continue;
        seen.set(d.threadId, d);
        next.push(d.path);
      }
    }
    frontier = next;
  }
  return [...seen.values()];
}
