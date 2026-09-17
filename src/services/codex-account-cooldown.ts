/**
 * Codex accounts parked after the app-server refused a turn for an exhausted quota.
 *
 * Kept apart from the account rows on purpose. `CodexAccountStatus` is the user's switch —
 * on or off — and writing a quota refusal into it would show an account the user never
 * disabled as switched off in Settings, with no way to tell the two apart when it came
 * back. Parking is the server's own short-lived opinion about an account, so it lives in
 * memory and lapses on its own.
 *
 * In-memory is also the honest lifetime: the park exists to stop a rotation from handing
 * the next turn straight back to the account that just refused it, and a server restart
 * re-learns that on the first refusal anyway.
 */

/** accountId → epoch ms at which the account is worth trying again. */
const parkedUntil = new Map<string, number>();

/**
 * How long an account sits out when the refusal carried no reset time.
 *
 * Codex's short bucket is five hours, so that is the cheapest correct guess. Guessing long
 * is safe in a way guessing short is not: an account that recovers early is only skipped
 * while another one can serve, whereas a park that lapses too early sends the turn back to
 * an account that refuses it again.
 */
const DEFAULT_PARK_MS = 5 * 60 * 60 * 1000;

/** Park an account until its quota resets. `resetAtMs` in the past falls back to the default. */
export function markCodexAccountUsageLimited(accountId: string, resetAtMs?: number): void {
  const now = Date.now();
  const until = resetAtMs != null && resetAtMs > now ? resetAtMs : now + DEFAULT_PARK_MS;
  parkedUntil.set(accountId, until);
}

/** Whether the account is still sitting out. Lapsed entries are dropped as they are read. */
export function isCodexAccountUsageLimited(accountId: string): boolean {
  const until = parkedUntil.get(accountId);
  if (until == null) return false;
  if (until <= Date.now()) { parkedUntil.delete(accountId); return false; }
  return true;
}

/** When the account is next worth trying, or null if it is not parked. */
export function codexUsageLimitResetAt(accountId: string): number | null {
  return isCodexAccountUsageLimited(accountId) ? parkedUntil.get(accountId)! : null;
}

/** Let an account back in early — a successful turn proves the park is stale. */
export function clearCodexAccountUsageLimit(accountId: string): void {
  parkedUntil.delete(accountId);
}

/** Test seam: forget every park. */
export function _resetCodexCooldownsForTesting(): void {
  parkedUntil.clear();
}
