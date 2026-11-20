/**
 * Which chats' subprocesses to release. Pure: the chat registry hands in the quiet ones.
 *
 * A chat's Claude CLI is ~700 MB on its own and about 1 GB with its MCP servers, and PPM used to
 * keep it for as long as any tab showed the chat: on 20/11/2026, 18–19 of them held 12.7–13.6 GB
 * when the machine ran out of memory. Two reasons to let one go, both only between turns, with no
 * card waiting and no background work (the caller's filter):
 * - `idle`: nothing has happened in the chat for the configured minutes (60 by default — the
 *   prompt cache's longest window, so nothing cached is thrown away). The next message starts a
 *   new subprocess, which costs a few seconds.
 * - `memory`: free commit is under the block threshold. The longest-idle go first, a few per
 *   reading, and never one whose turn ended moments ago (the user is probably reading it).
 */

export interface QuietSession {
  sessionId: string;
  /** When the chat last did anything: its last turn ended, or its last client left. */
  quietSince: number;
}

export interface ReleasePick {
  sessionId: string;
  why: "idle" | "memory";
}

/** Released under memory pressure per reading, at most. */
export const MAX_MEMORY_RELEASES_PER_TICK = 3;
/** A chat quiet for less than this is not released for memory. */
export const MIN_QUIET_FOR_MEMORY_MS = 2 * 60_000;

export function selectIdleReleases(
  quiet: readonly QuietSession[],
  now: number,
  opts: { idleMinutes: number; memoryLow: boolean },
): ReleasePick[] {
  const picks: ReleasePick[] = [];
  const left: QuietSession[] = [];
  for (const q of quiet) {
    if (opts.idleMinutes > 0 && now - q.quietSince >= opts.idleMinutes * 60_000) picks.push({ sessionId: q.sessionId, why: "idle" });
    else left.push(q);
  }
  if (opts.memoryLow) {
    const byOldest = left.filter((q) => now - q.quietSince >= MIN_QUIET_FOR_MEMORY_MS).sort((a, b) => a.quietSince - b.quietSince);
    for (const q of byOldest.slice(0, MAX_MEMORY_RELEASES_PER_TICK)) picks.push({ sessionId: q.sessionId, why: "memory" });
  }
  return picks;
}
