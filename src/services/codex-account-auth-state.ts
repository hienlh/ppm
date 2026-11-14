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
 * The usage sweep is what notices a signed-out account and keeps it benched, and it backs off
 * while the account stays signed out: each refusal in a row doubles the wait before the next
 * read (5, 10, 20, 40, then every 60 minutes). Reading a dead login every five minutes spawned
 * an app-server for nothing and wrote the same refresh error into the log 288 times a day.
 * The mark outlives the wait by `MARK_TTL_MS`, so the account stays benched between reads,
 * yet a misread error still cannot bench an account forever. A successful usage read, a
 * completed turn or a fresh sign-in clears it at once.
 */

const MARK_TTL_MS = 15 * 60 * 1000;
const FIRST_RECHECK_MS = 5 * 60 * 1000;
const MAX_RECHECK_MS = 60 * 60 * 1000;

interface AuthFailure {
  until: number;
  reason: string;
  since: number;
  /** Refusals seen in a row, the first one included. */
  strikes: number;
  /** Before this, the background sweep leaves the account alone. */
  recheckAt: number;
}

const failures = new Map<string, AuthFailure>();

/** The wait before the next background read after `strikes` refusals in a row. */
export function codexAuthRecheckDelayMs(strikes: number): number {
  return Math.min(FIRST_RECHECK_MS * 2 ** Math.max(0, strikes - 1), MAX_RECHECK_MS);
}

/** Record that this account's login was refused. */
export function markCodexAccountAuthFailed(accountId: string, reason: string): void {
  const now = Date.now();
  const prev = failures.get(accountId);
  const fresh = !prev || prev.until <= now;
  // Only a refusal on a read that was due widens the wait. Several turns in flight on one
  // account all fail on the same transient 401 within a second; counting each would bench a
  // recovered account for an hour instead of re-reading it at the next sweep.
  const due = fresh || now >= prev.recheckAt;
  const strikes = fresh ? 1 : due ? prev.strikes + 1 : prev.strikes;
  const recheckAt = due ? now + codexAuthRecheckDelayMs(strikes) : prev.recheckAt;
  const until = Math.max(fresh ? 0 : prev.until, recheckAt + MARK_TTL_MS);
  failures.set(accountId, { until, reason, since: fresh ? now : prev.since, strikes, recheckAt });
  if (fresh) console.warn(`[codex] account ${accountId} is signed out — skipping it until it signs in again`);
}

/** Whether the account is currently known to be signed out. Lapsed marks drop as read. */
export function isCodexAccountAuthFailed(accountId: string): boolean {
  const f = failures.get(accountId);
  if (!f) return false;
  if (f.until <= Date.now()) { failures.delete(accountId); return false; }
  return true;
}

/**
 * Whether the background sweep should leave this account alone for now: it is known to be
 * signed out and its next read is not due yet. An account that is not marked is always due.
 */
export function isCodexAccountAuthRecheckPending(accountId: string): boolean {
  return isCodexAccountAuthFailed(accountId) && Date.now() < failures.get(accountId)!.recheckAt;
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
