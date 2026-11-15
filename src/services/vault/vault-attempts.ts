import type { VaultLockedTier } from "../../shared/vault.ts";
import { getKeyRow, setAttempts } from "./vault-db.ts";

/**
 * Wrong-password counting, one counter per locked tier, kept in `vault_keys` so a restart does
 * not reset it. A wrong password on one tier never counts against the other. The card in a chat
 * and Settings share the counter.
 *
 * After `free` wrong passwords in a row each further one locks the tier for `baseMs`, doubled
 * per wrong password and capped at `maxMs`. While locked out no password is tried at all, so no
 * scrypt runs. A right password sets the counter back to zero.
 */

export interface AttemptPolicy {
  free: number;
  baseMs: number;
  maxMs: number;
}

export const ATTEMPT_POLICY: Record<VaultLockedTier, AttemptPolicy> = {
  secure: { free: 5, baseMs: 30_000, maxMs: 15 * 60_000 },
  sealed: { free: 3, baseMs: 60_000, maxMs: 60 * 60_000 },
};

/** The secure tier raises an alarm past this many wrong passwords within an hour. */
export const SECURE_ALARM_PER_HOUR = 20;

/** How long the `failed`-th wrong password in a row locks the tier; 0 while still free. */
export function lockoutMs(policy: AttemptPolicy, failed: number): number {
  if (failed < policy.free) return 0;
  return Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(30, failed - policy.free));
}

export type AttemptGate = { ok: true } | { ok: false; retryAfterMs: number };

export type VaultAlarm = { tier: "secure"; kind: "many-failures" } | { tier: "sealed"; kind: "locked-out" };

export function createVaultAttempts(opts: { now?: () => number; onAlarm?: (alarm: VaultAlarm) => void } = {}) {
  const now = opts.now ?? Date.now;
  const recentSecureFailures: number[] = [];
  let secureAlarmUntil = 0;

  /** Whether a password may be tried now. */
  function gate(tier: VaultLockedTier): AttemptGate {
    const row = getKeyRow(tier);
    if (!row) return { ok: true };
    const wait = row.locked_until - now();
    return wait > 0 ? { ok: false, retryAfterMs: wait } : { ok: true };
  }

  function attemptsLeft(tier: VaultLockedTier): number {
    const row = getKeyRow(tier);
    if (!row) return ATTEMPT_POLICY[tier].free;
    return Math.max(0, ATTEMPT_POLICY[tier].free - row.failed_attempts);
  }

  /** Records a wrong password; answers how many are left before a lockout, or how long it lasts. */
  function recordFailure(tier: VaultLockedTier): { attemptsLeft: number; lockedForMs: number } {
    const row = getKeyRow(tier);
    if (!row) return { attemptsLeft: 0, lockedForMs: 0 };
    const policy = ATTEMPT_POLICY[tier];
    const failed = row.failed_attempts + 1;
    const lockedForMs = lockoutMs(policy, failed);
    setAttempts(tier, failed, lockedForMs > 0 ? now() + lockedForMs : 0);
    try {
      if (tier === "sealed" && failed === policy.free) opts.onAlarm?.({ tier, kind: "locked-out" });
      if (tier === "secure") {
        const t = now();
        recentSecureFailures.push(t);
        while (recentSecureFailures.length && recentSecureFailures[0]! <= t - 3_600_000) recentSecureFailures.shift();
        if (recentSecureFailures.length > SECURE_ALARM_PER_HOUR && t >= secureAlarmUntil) {
          secureAlarmUntil = t + 3_600_000;
          opts.onAlarm?.({ tier, kind: "many-failures" });
        }
      }
    } catch { /* an alarm is a notice; it never decides the attempt */ }
    return { attemptsLeft: Math.max(0, policy.free - failed), lockedForMs };
  }

  function recordSuccess(tier: VaultLockedTier): void {
    const row = getKeyRow(tier);
    if (row && (row.failed_attempts !== 0 || row.locked_until !== 0)) setAttempts(tier, 0, 0);
  }

  return { gate, attemptsLeft, recordFailure, recordSuccess };
}

export type VaultAttempts = ReturnType<typeof createVaultAttempts>;
