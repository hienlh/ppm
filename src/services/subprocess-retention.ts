/**
 * How long a clientless session may keep its SDK subprocess alive.
 *
 * A disconnect is usually a tab refresh, a phone switching apps or a laptop sleeping, and the
 * client is back within seconds. Killing the subprocess on the spot forces the next message
 * down the resume path, which replays the whole transcript and pays cache-write rates for a
 * prefix that was already cached — the reason the subprocess is kept at all.
 *
 * What bounds that generosity is not the disconnect but the prompt cache: once the cache
 * behind the prefix has expired, the subprocess protects nothing and is only holding memory.
 * These decisions live here, apart from the WebSocket wiring, so the timing they encode can
 * be tested without standing up a session.
 */

/**
 * Anthropic's default prompt-cache lifetime. A prefix not re-sent within this window has to
 * be written to the cache again, so a subprocess older than this is worth nothing.
 *
 * Named here rather than inlined because the retention window is *derived* from it — the two
 * were previously equal by coincidence, which read as if the teardown delay were arbitrary.
 */
export const PROMPT_CACHE_TTL_MS = 5 * 60_000;

/**
 * Milliseconds until a session's prompt cache lapses.
 *
 * Measured from the last completed turn, because that is when the cache was last written —
 * not from the disconnect, which says nothing about the cache. Returns 0 once the window has
 * already passed, meaning the subprocess can go immediately.
 */
export function cacheReleaseDelayMs(
  lastTurnEndedAt: number | undefined,
  now: number,
  ttlMs: number = PROMPT_CACHE_TTL_MS,
): number {
  // No completed turn means nothing has been cached, so there is nothing to protect.
  if (lastTurnEndedAt == null) return 0;
  return Math.max(0, lastTurnEndedAt + ttlMs - now);
}

export interface WarmIdleSession {
  sessionId: string;
  /** When the session's last client left. Absent is treated as "longest idle". */
  idleSince?: number;
}

/**
 * Which held subprocesses to release when too many sessions are holding one.
 *
 * The grace period costs one Claude Code process per abandoned session, and PPM is built to
 * be reachable from several devices, so abandoned sessions accumulate. Eviction takes the
 * longest-idle sessions first: their caches are the closest to expiring, so their
 * subprocesses are the ones worth the least.
 *
 * Returns session ids in eviction order; empty when the cap is not exceeded.
 */
export function selectWarmIdleEvictions(sessions: WarmIdleSession[], cap: number): string[] {
  if (cap < 0 || sessions.length <= cap) return [];
  const byIdleAscending = [...sessions].sort(
    (a, b) => (a.idleSince ?? 0) - (b.idleSince ?? 0),
  );
  return byIdleAscending.slice(0, sessions.length - cap).map((s) => s.sessionId);
}
