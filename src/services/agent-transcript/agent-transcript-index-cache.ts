/**
 * Shared cache over `groupSubagentsByCard`, so the hub and
 * `nested-subagent-spy.ts` cost one directory scan per session per refresh
 * window between them, not one each. `groupSubagentsByCard` itself reads
 * every `*.meta.json` in the subagents dir — cheap for one caller, not for
 * two independent pollers doing it every tick.
 *
 * Refreshed at most every `INDEX_REFRESH_MS`, except a directory mtime change
 * (a new agent spawned, one finished) forces an immediate refresh regardless
 * of how recently the last one ran — the 2s floor bounds cost, the mtime
 * check bounds staleness.
 */
import {
  groupSubagentsByCard, indexTranscriptsByMember,
  type SubagentTranscriptEntry,
} from "../team-member-activity/subagent-transcript-index.ts";
import { agentTranscriptClock } from "./agent-transcript-hub-clock.ts";
import { statDirMtimeSafe } from "./agent-transcript-fs-io.ts";
import { INDEX_REFRESH_MS } from "../../shared/agent-transcript-protocol.ts";

/** Bounds how many distinct subagents dirs stay cached at once — a server with
 *  many sessions ever subscribed-to should not keep every one of them forever. */
const MAX_CACHE_ENTRIES = 200;

interface CacheEntry {
  groups: Map<string, SubagentTranscriptEntry[]>;
  byMember: Map<string, SubagentTranscriptEntry>;
  refreshedAt: number;
  dirMtimeMs: number | null;
}

const cache = new Map<string, CacheEntry>();

function evictOldestIfOverCapacity(): void {
  if (cache.size < MAX_CACHE_ENTRIES) return;
  let oldestKey: string | undefined;
  let oldestAt = Infinity;
  for (const [key, entry] of cache) {
    if (entry.refreshedAt < oldestAt) {
      oldestAt = entry.refreshedAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) cache.delete(oldestKey);
}

function refresh(subagentsDir: string): CacheEntry {
  evictOldestIfOverCapacity();
  const entry: CacheEntry = {
    groups: groupSubagentsByCard(subagentsDir),
    byMember: indexTranscriptsByMember(subagentsDir),
    refreshedAt: agentTranscriptClock.now(),
    dirMtimeMs: statDirMtimeSafe(subagentsDir),
  };
  cache.set(subagentsDir, entry);
  return entry;
}

function cached(subagentsDir: string): CacheEntry {
  const now = agentTranscriptClock.now();
  const existing = cache.get(subagentsDir);
  if (!existing) return refresh(subagentsDir);

  const currentMtime = statDirMtimeSafe(subagentsDir);
  const mtimeChanged = currentMtime !== null && currentMtime !== existing.dirMtimeMs;
  if (mtimeChanged || now - existing.refreshedAt >= INDEX_REFRESH_MS) return refresh(subagentsDir);
  return existing;
}

/** Cached `groupSubagentsByCard(subagentsDir)`, refreshed per the policy above. */
export function getCachedSubagentGroups(subagentsDir: string): Map<string, SubagentTranscriptEntry[]> {
  return cached(subagentsDir).groups;
}

/** Cached `indexTranscriptsByMember(subagentsDir)`, same refresh policy as the
 *  card-group index — the activity feed's team-member pass used to re-read
 *  every `*.meta.json` itself, uncached, on top of the group scan above. */
export function getCachedTranscriptsByMember(subagentsDir: string): Map<string, SubagentTranscriptEntry> {
  return cached(subagentsDir).byMember;
}

/** Test-only: forget every cached entry. */
export function _resetAgentTranscriptIndexCache(): void {
  cache.clear();
}
