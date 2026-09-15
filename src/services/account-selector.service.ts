import { accountService, type AccountWithTokens } from "./account.service.ts";
import {
  getConfigValue,
  setConfigValue,
  getLatestSnapshotForAccount,
  getSessionAccount,
  setSessionAccount,
} from "./db.service.ts";

export type AccountStrategy = "round-robin" | "fill-first" | "lowest-usage";

const STRATEGY_CONFIG_KEY = "account_strategy";
const MAX_RETRY_CONFIG_KEY = "account_max_retry";
const COOLDOWN_ENABLED_KEY = "account_cooldown_enabled";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const AUTH_BACKOFF_BASE_MS = 5 * 60_000; // 5min base for auth errors (longer than rate limits)
/** Skip accounts whose 5-hour utilization >= this threshold (proactive avoidance) */
const FIVE_HOUR_SKIP_THRESHOLD = 0.95;
/** Weekly utilization at which an account has nothing left to give until its reset. */
const WEEKLY_EXHAUSTED_UTIL = 1.0;

class AccountSelectorService {
  private cursor = 0;
  private retryCounts = new Map<string, number>();
  private _lastPickedId: string | null = null;

  /** ID of the last account returned by next() */
  get lastPickedId(): string | null {
    return this._lastPickedId;
  }

  getStrategy(): AccountStrategy {
    return (getConfigValue(STRATEGY_CONFIG_KEY) as AccountStrategy) ?? "round-robin";
  }

  setStrategy(strategy: AccountStrategy): void {
    setConfigValue(STRATEGY_CONFIG_KEY, strategy);
  }

  getMaxRetry(): number {
    const v = getConfigValue(MAX_RETRY_CONFIG_KEY);
    return v ? parseInt(v, 10) : 0;
  }

  setMaxRetry(n: number): void {
    setConfigValue(MAX_RETRY_CONFIG_KEY, String(n));
  }

  /**
   * Whether to park failing accounts in cooldown. Default OFF — account rotation already
   * avoids maxed accounts via the 5-hour usage skip ([[FIVE_HOUR_SKIP_THRESHOLD]]), and the
   * per-turn exclusion sets in the provider prevent re-hammering within a request, so the
   * artificial cooldown lockout mostly just blocks otherwise-usable accounts.
   * Set config "account_cooldown_enabled" = "true" to restore cooldown parking.
   */
  isCooldownEnabled(): boolean {
    return getConfigValue(COOLDOWN_ENABLED_KEY) === "true";
  }

  setCooldownEnabled(on: boolean): void {
    setConfigValue(COOLDOWN_ENABLED_KEY, String(on));
  }

  /** Reason for the last null return from next() */
  private _lastFailReason: "none" | "no_active" | "all_decrypt_failed" | "all_excluded" = "none";

  /** Why the last next() call returned null */
  get lastFailReason(): "none" | "no_active" | "all_decrypt_failed" | "all_excluded" {
    return this._lastFailReason;
  }

  /** Re-enable accounts whose cooldown has elapsed, so they rejoin the candidate pool. */
  private clearExpiredCooldowns(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const acc of accountService.list()) {
      if (acc.status === "cooldown" && acc.cooldownUntil && acc.cooldownUntil <= now) {
        try {
          accountService.setEnabled(acc.id);
          this.retryCounts.delete(acc.id);
        } catch {
          // Account expired or cannot be re-enabled — disable it
          accountService.setDisabled(acc.id);
          this.retryCounts.delete(acc.id);
        }
      }
    }
  }

  /** Status test from next()'s candidate filter — disabled and parked accounts are out. */
  private isSelectable(accountId: string): boolean {
    const acc = accountService.list().find((a) => a.id === accountId);
    if (!acc) return false;
    const cooldownOn = this.isCooldownEnabled();
    return acc.status === "active" || (!cooldownOn && acc.status === "cooldown");
  }

  /**
   * Whether an account still holds a token it could authenticate with.
   *
   * An account with no refresh token whose access token has already expired cannot serve
   * anything: there is no way back to a live token without a fresh sign-in. Picking one
   * only moves the failure later, into the middle of a turn, where it costs a retry and
   * an account switch instead of simply being skipped here.
   *
   * Same test the enable path and the account card use, so a card reading "Expired" and
   * the router agreeing it is unusable can never drift apart.
   *
   * Three outcomes, not two. A token that cannot be decrypted is deliberately kept in the
   * pool: that is the machine-key mismatch, which has its own diagnostic downstream ("copy
   * ~/.ppm/account.key from the original machine"). Dropping those accounts here would
   * leave the caller reporting them as merely disabled and swallow the one message that
   * actually tells the user what went wrong.
   *
   * The decrypt only runs for an account whose access token has already expired, so the
   * cipher stays off the hot path for the healthy case.
   */
  private hasUsableToken(accountId: string): boolean {
    const acc = accountService.list().find((a) => a.id === accountId);
    if (!acc) return false;
    if (!acc.expiresAt) return true;
    if (acc.expiresAt >= Math.floor(Date.now() / 1000)) return true;
    const withTokens = accountService.getWithTokens(accountId);
    if (!withTokens) return true; // undecryptable — not this filter's call to make
    return withTokens.refreshToken.length > 0;
  }

  /**
   * The hard test: an account that fails this cannot serve a turn at all.
   *
   * Kept separate from [[hasQuotaRoom]] on purpose. Quota is a soft limit — when every
   * account is near its cap the router still hands one back, because a throttled turn beats
   * no turn. A dead token has no such fallback: there is nothing on the other side of it,
   * so it is filtered out with no escape hatch.
   */
  private isUsable(accountId: string): boolean {
    return this.isSelectable(accountId) && this.hasUsableToken(accountId);
  }

  /**
   * Whether this account could serve a turn if a caller asked for it by name.
   *
   * The hard test only. A caller naming a specific account — a user picking one in the
   * panel, or a tab redeeming the account it claimed — is allowed to land on one that is
   * near its cap; that is a choice to make a slower turn, not an impossible one. It is not
   * allowed to land on one that is disabled or has no live token, which is the same line
   * the router itself draws.
   */
  canServe(accountId: string): boolean {
    return this.isUsable(accountId);
  }

  /**
   * Whether an account has quota left to serve a turn.
   *
   * Mirrors next()'s proactive 5-hour skip, and adds the weekly exhaustion that otherwise
   * only the lowest-usage strategy scores. A binding has to respect both: on five-hour
   * alone, a session stays pinned to an account whose weekly quota is spent the moment its
   * 5-hour window resets, which is exactly the account next() would have avoided.
   */
  private hasQuotaRoom(accountId: string): boolean {
    const snap = getLatestSnapshotForAccount(accountId);
    if (!snap) return true;
    if ((snap.five_hour_util ?? 0) >= FIVE_HOUR_SKIP_THRESHOLD) return false;
    return (snap.weekly_util ?? 0) < WEEKLY_EXHAUSTED_UTIL;
  }

  /**
   * Whether any selectable account still has room.
   *
   * Tells the caller whether next() would be picking a real candidate or falling back to
   * "everything is near the cap, take one anyway" — a distinction a binding must not ignore.
   */
  private anyAccountHasQuotaRoom(excludeIds?: Set<string>): boolean {
    return accountService.list().some((a) => {
      if (excludeIds?.has(a.id)) return false;
      if (!this.isUsable(a.id)) return false;
      return this.hasQuotaRoom(a.id);
    });
  }

  /**
   * Account bound to a session, falling back to a strategy pick that then becomes the binding.
   *
   * Anthropic's prompt cache is scoped per account, so moving a session to a different
   * account re-sends its entire transcript as a cache write (1.25x) instead of a cache
   * read (0.1x). On a long session that is the difference between a cheap turn and a
   * very expensive one, which is why the binding exists at all.
   *
   * Rotation is not abandoned, only relocated: a session with no binding yet still goes
   * through the configured strategy, so load still spreads — just per session rather than
   * per turn. `bindSession` moves a session when an account genuinely cannot serve it.
   */
  forSession(sessionId: string, excludeIds?: Set<string>): AccountWithTokens | null {
    this.clearExpiredCooldowns();
    const boundId = getSessionAccount(sessionId);
    if (boundId && !excludeIds?.has(boundId) && this.isUsable(boundId)) {
      // Hold the binding while it has room, and also when nothing else does. In that second
      // case next() falls back to returning a near-capped account anyway, and round-robin
      // would hand back a different one each turn — paying a full cache write per turn to
      // move between accounts that are equally out of room.
      if (this.hasQuotaRoom(boundId) || !this.anyAccountHasQuotaRoom(excludeIds)) {
        const bound = accountService.getWithTokens(boundId);
        if (bound) {
          this._lastPickedId = boundId;
          this._lastFailReason = "none";
          return bound;
        }
      }
    }
    const picked = this.next(excludeIds);
    if (picked) this.bindSession(sessionId, picked.id);
    return picked;
  }

  /** Move a session onto an account — used when a switch is forced (rate/usage limit, auth). */
  bindSession(sessionId: string, accountId: string): void {
    setSessionAccount(sessionId, accountId);
  }

  /**
   * Pick next available account (skips cooldown/disabled).
   * Returns null if no active accounts available.
   */
  next(excludeIds?: Set<string>): AccountWithTokens | null {
    this._lastFailReason = "none";
    this.clearExpiredCooldowns();

    // Status and token together: isUsable() keeps a parked account in the running when
    // cooldown is switched off, and drops one whose token is past saving. Dead tokens are
    // filtered here rather than at the quota step below, because that step falls back to
    // "take one anyway" and an unauthenticable account must not be reachable through it.
    const active = accountService.list().filter((a) => this.isUsable(a.id));
    // Skip accounts excluded by caller (e.g., pre-flight loop)
    const notExcluded = excludeIds?.size ? active.filter((a) => !excludeIds.has(a.id)) : active;
    if (notExcluded.length === 0) {
      this._lastFailReason = active.length > 0 ? "all_excluded" : "no_active";
      return null;
    }

    // Proactive: skip accounts that are out of 5-hour or weekly room
    const withRoom = notExcluded.filter((a) => this.hasQuotaRoom(a.id));
    const candidates = withRoom.length > 0 ? withRoom : notExcluded; // fallback to all if every account is near limit

    let pickedId: string;
    const strategy = this.getStrategy();
    if (strategy === "lowest-usage") {
      pickedId = this.pickLowestUsage(candidates);
    } else if (strategy === "fill-first") {
      const sorted = [...candidates].sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
      pickedId = sorted[0]!.id;
    } else {
      // Round-robin
      this.cursor = this.cursor % candidates.length;
      pickedId = candidates[this.cursor]!.id;
      this.cursor = (this.cursor + 1) % candidates.length;
    }
    this._lastPickedId = pickedId;
    const result = accountService.getWithTokens(pickedId);
    if (!result) {
      this._lastFailReason = "all_decrypt_failed";
    }
    return result;
  }

  /**
   * Peek at which account the current strategy would pick, without consuming it.
   * Returns null if no active accounts.
   */
  peek(): AccountWithTokens | null {
    const now = Math.floor(Date.now() / 1000);
    const cooldownOn = this.isCooldownEnabled();
    // Same two-tier filter next() applies: dead tokens are out with no escape hatch,
    // out-of-quota accounts are skipped but still reachable when nothing else is left.
    // A preview that answers from a looser filter than the router is a preview that
    // names an account the very next turn will refuse to use.
    const active = accountService.list().filter(
      (a) =>
        (a.status === "active" || (a.status === "cooldown" && (!cooldownOn || (a.cooldownUntil ?? 0) <= now)))
        && this.hasUsableToken(a.id),
    );
    if (active.length === 0) return null;
    const withRoom = active.filter((a) => this.hasQuotaRoom(a.id));
    const candidates = withRoom.length > 0 ? withRoom : active;

    const strategy = this.getStrategy();
    let pickedId: string;
    if (strategy === "lowest-usage") {
      pickedId = this.pickLowestUsage(candidates);
    } else if (strategy === "fill-first") {
      const sorted = [...candidates].sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
      pickedId = sorted[0]!.id;
    } else {
      const idx = this.cursor % candidates.length;
      pickedId = candidates[idx]!.id;
    }
    return accountService.getWithTokens(pickedId);
  }

  /**
   * Weighted sustainability score.
   * Considers 5-hour utilization, weekly utilization, and time until weekly reset.
   *
   * score = 0.35 × (1 - 5hr) + 0.65 × min(weeklyRemaining / resetRatio, 2.0) / 2.0
   *
   * weeklyRemaining / resetRatio normalizes remaining capacity by time until reset.
   * Capped at 2.0 (not 1.0) so accounts with imminent reset score higher:
   *  - 4% remaining with 34h left  → raw 0.20, scaled 0.10 (low)
   *  - 78% remaining with 113h left → raw 1.16, scaled 0.58 (good)
   *  - 44% remaining with 32h left  → raw 2.32, scaled 1.00 (great — resets soon)
   *  - 20% remaining with 6h left   → raw 5.6,  scaled 1.00 (great — resets very soon)
   */
  private pickLowestUsage(active: { id: string; createdAt: number }[]): string {
    const scored = active.map((acc) => {
      const snap = getLatestSnapshotForAccount(acc.id);
      const fiveHour = snap?.five_hour_util ?? 0;
      const weekly = snap?.weekly_util ?? 0;
      const exhausted = weekly >= 1.0 || fiveHour >= 1.0;

      // Compute hours until weekly reset (default 168h = full week if unknown)
      let weeklyResetHours = 168;
      if (snap?.weekly_resets_at) {
        const diff = new Date(snap.weekly_resets_at).getTime() - Date.now();
        weeklyResetHours = Math.max(diff / 3_600_000, 0.1);
      }

      const immediate = 1 - fiveHour;
      const weeklyRemaining = 1 - weekly;
      const resetRatio = weeklyResetHours / 168;
      const sustainability = Math.min(weeklyRemaining / Math.max(resetRatio, 0.05), 2.0) / 2.0;
      const score = 0.35 * immediate + 0.65 * sustainability;

      return { id: acc.id, score, exhausted };
    });

    const available = scored.filter((s) => !s.exhausted);
    if (available.length > 0) {
      available.sort((a, b) => b.score - a.score);
      return available[0]!.id;
    }

    // All exhausted — pick highest score as fallback
    scored.sort((a, b) => b.score - a.score);
    return scored[0]!.id;
  }

  /** Called when account receives 429 — apply exponential backoff */
  onRateLimit(accountId: string): void {
    const retries = (this.retryCounts.get(accountId) ?? 0) + 1;
    this.retryCounts.set(accountId, retries);
    if (!this.isCooldownEnabled()) return;
    const backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, retries - 1), BACKOFF_MAX_MS);
    const cooldownUntilMs = Date.now() + backoffMs;
    accountService.setCooldown(accountId, cooldownUntilMs);
    console.log(`[accounts] ${accountId} rate limited — cooldown ${Math.round(backoffMs / 1000)}s (retry #${retries})`);
  }

  /** Called when account hits a hard usage/session limit (5h/weekly cap).
   *  Cooldown until the real reset time (or ~1h fallback). Does NOT bump retryCounts —
   *  this is a quota ceiling, not a transient failure, so it carries no escalating penalty. */
  onUsageLimit(accountId: string, resetAtMs?: number): void {
    if (!this.isCooldownEnabled()) return;
    const FALLBACK_MS = 60 * 60_000; // 1 hour
    const cooldownUntilMs =
      resetAtMs && resetAtMs > Date.now() ? resetAtMs : Date.now() + FALLBACK_MS;
    accountService.setCooldown(accountId, cooldownUntilMs);
    const mins = Math.round((cooldownUntilMs - Date.now()) / 60_000);
    console.log(`[accounts] ${accountId} usage limit — cooldown ${mins}m (until reset)`);
  }

  /** Called when auth error (401 / authentication_failed) — cooldown with longer backoff */
  onAuthError(accountId: string): void {
    const retries = (this.retryCounts.get(accountId) ?? 0) + 1;
    this.retryCounts.set(accountId, retries);
    if (!this.isCooldownEnabled()) return;
    const backoffMs = Math.min(AUTH_BACKOFF_BASE_MS * Math.pow(2, retries - 1), BACKOFF_MAX_MS);
    accountService.setCooldown(accountId, Date.now() + backoffMs);
    console.log(`[accounts] ${accountId} auth error — cooldown ${Math.round(backoffMs / 1000)}s (retry #${retries})`);
  }

  private static readonly PREFLIGHT_BACKOFF_BASE_MS = 60_000; // 1 minute
  private static readonly PREFLIGHT_BACKOFF_MAX_MS = 5 * 60_000; // 5 minutes

  /** Called when pre-flight token refresh fails — short cooldown.
   *  Shares retryCounts with onRateLimit/onAuthError (cumulative penalty by design). */
  onPreflightFail(accountId: string): void {
    const retries = (this.retryCounts.get(accountId) ?? 0) + 1;
    this.retryCounts.set(accountId, retries);
    if (!this.isCooldownEnabled()) return;
    const backoffMs = Math.min(
      AccountSelectorService.PREFLIGHT_BACKOFF_BASE_MS * Math.pow(2, retries - 1),
      AccountSelectorService.PREFLIGHT_BACKOFF_MAX_MS,
    );
    accountService.setCooldown(accountId, Date.now() + backoffMs);
    console.log(`[accounts] ${accountId} preflight refresh failed — cooldown ${Math.round(backoffMs / 1000)}s (retry #${retries})`);
  }

  /** Called on successful request — reset retry count + track usage */
  onSuccess(accountId: string): void {
    this.retryCounts.delete(accountId);
    accountService.trackUsage(accountId);
  }

  /** How many accounts are active or have expired cooldowns right now */
  activeCount(): number {
    const now = Math.floor(Date.now() / 1000);
    const cooldownOn = this.isCooldownEnabled();
    return accountService.list().filter(
      (a) => a.status === "active" || (a.status === "cooldown" && (!cooldownOn || (a.cooldownUntil ?? 0) <= now)),
    ).length;
  }

  /** True if multi-account mode is enabled (≥1 account in DB) */
  isEnabled(): boolean {
    return accountService.list().length > 0;
  }
}

export const accountSelector = new AccountSelectorService();
