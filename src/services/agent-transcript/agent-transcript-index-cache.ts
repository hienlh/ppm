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
import { groupSubagentsByCard, type SubagentTranscriptEntry } from "../team-member-activity/subagent-transcript-index.ts";
import { agentTranscriptClock } from "./agent-transcript-hub-clock.ts";
import { statDirMtimeSafe } from "./agent-transcript-fs-io.ts";
import { INDEX_REFRESH_MS } from "../../shared/agent-transcript-protocol.ts";

interface CacheEntry {
  groups: Map<string, SubagentTranscriptEntry[]>;
  refreshedAt: number;
  dirMtimeMs: number | null;
}

const cache = new Map<string, CacheEntry>();

function refresh(subagentsDir: string): CacheEntry {
  const entry: CacheEntry = {
    groups: groupSubagentsByCard(subagentsDir),
    refreshedAt: agentTranscriptClock.now(),
    dirMtimeMs: statDirMtimeSafe(subagentsDir),
  };
  cache.set(subagentsDir, entry);
  return entry;
}

/** Cached `groupSubagentsByCard(subagentsDir)`, refreshed per the policy above. */
export function getCachedSubagentGroups(subagentsDir: string): Map<string, SubagentTranscriptEntry[]> {
  const now = agentTranscriptClock.now();
  const existing = cache.get(subagentsDir);
  if (!existing) return refresh(subagentsDir).groups;

  const currentMtime = statDirMtimeSafe(subagentsDir);
  const mtimeChanged = currentMtime !== null && currentMtime !== existing.dirMtimeMs;
  if (mtimeChanged || now - existing.refreshedAt >= INDEX_REFRESH_MS) return refresh(subagentsDir).groups;
  return existing.groups;
}

/** Test-only: forget every cached entry. */
export function _resetAgentTranscriptIndexCache(): void {
  cache.clear();
}
