/**
 * Backoff schedule for re-attempting a named tunnel after it lost a spawn and
 * the supervisor fell back to a quick URL.
 *
 * The fallback exists so a broken named setup never leaves the machine dark,
 * but it used to be one-way: once quick was live, named was only retried on the
 * next supervisor start or an explicit `retunnel`. That is wrong for a
 * *transient* failure — observed live, a laptop waking from sleep spawns the
 * connector before Wi-Fi is back, the 30s readiness wait expires, and the
 * permanent hostname then serves 530 for hours even though the network
 * recovered seconds later.
 */

/** 1min, 5min, 15min — then stop and leave the warning standing. */
export const NAMED_RETRY_DELAYS_MS = [60_000, 300_000, 900_000] as const;

/**
 * Delay before retry number `attempt` (0-based), or null once the schedule is
 * exhausted. Bounded on purpose: a genuinely broken setup (deleted tunnel,
 * revoked token) must settle on quick with a visible warning rather than
 * restart the connector forever.
 */
export function nextNamedRetryDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0) return null;
  return NAMED_RETRY_DELAYS_MS[attempt] ?? null;
}
