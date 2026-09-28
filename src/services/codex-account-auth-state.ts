/**
 * Codex accounts the server has seen refused for a revoked or expired login.
 *
 * Sibling of `codex-account-cooldown.ts`, and in memory for the same reason: this is the
 * server's own observation, not the user's on/off switch, and writing it into the account
 * row would show an account the user never touched as changed in Settings.
 *
 * Unlike a quota park this is a hard exclusion from selection. A spent quota still answers
 * slowly; a signed-out account never answers at all, and every turn handed to it costs a
 * subprocess and ~24s of codex retrying before it says so. That is what let a burst of
 * proxy requests pin the server until the supervisor killed it.
 *
 * The mark lapses on its own so a misread error cannot bench an account forever, and the
 * usage sweep (every 5 minutes) renews it for as long as the account really is signed out.
 * A successful usage read, a completed turn or a fresh sign-in clears it at once.
 */

const MARK_TTL_MS = 15 * 60 * 1000;

interface AuthFailure {
  until: number;
  reason: string;
  since: number;
}

const failures = new Map<string, AuthFailure>();

/** Record that this account's login was refused. */
export function markCodexAccountAuthFailed(accountId: string, reason: string): void {
  const now = Date.now();
  const prev = failures.get(accountId);
  const fresh = !prev || prev.until <= now;
  failures.set(accountId, { until: now + MARK_TTL_MS, reason, since: fresh ? now : prev.since });
  if (fresh) console.warn(`[codex] account ${accountId} is signed out — skipping it until it signs in again`);
}

/** Whether the account is currently known to be signed out. Lapsed marks drop as read. */
export function isCodexAccountAuthFailed(accountId: string): boolean {
  const f = failures.get(accountId);
  if (!f) return false;
  if (f.until <= Date.now()) { failures.delete(accountId); return false; }
  return true;
}

/** When the account was first seen signed out, or null if it is not. */
export function codexAccountAuthFailedSince(accountId: string): number | null {
  return isCodexAccountAuthFailed(accountId) ? failures.get(accountId)!.since : null;
}

/** The account answered normally again — drop the mark. */
export function clearCodexAccountAuthFailure(accountId: string): void {
  if (failures.delete(accountId)) console.log(`[codex] account ${accountId} is signed in again`);
}

/** Test seam: forget every mark. */
export function _resetCodexAuthFailuresForTesting(): void {
  failures.clear();
}
