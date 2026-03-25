import { accountService, type AccountWithTokens } from "./account.service.ts";
import { getConfigValue, setConfigValue, getLatestSnapshotForAccount } from "./db.service.ts";

export type AccountStrategy = "round-robin" | "fill-first" | "lowest-usage";

const STRATEGY_CONFIG_KEY = "account_strategy";
const MAX_RETRY_CONFIG_KEY = "account_max_retry";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const AUTH_BACKOFF_BASE_MS = 5 * 60_000; // 5min base for auth errors (longer than rate limits)

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

  /** Reason for the last null return from next() */
  private _lastFailReason: "none" | "no_active" | "all_decrypt_failed" = "none";

  /** Why the last next() call returned null */
  get lastFailReason(): "none" | "no_active" | "all_decrypt_failed" {
    return this._lastFailReason;
  }

  /**
   * Pick next available account (skips cooldown/disabled).
   * Returns null if no active accounts available.
   */
  next(): AccountWithTokens | null {
    this._lastFailReason = "none";
    const now = Math.floor(Date.now() / 1000);
    const allAccounts = accountService.list();

    // Clear expired cooldowns
    for (const acc of allAccounts) {
      if (acc.status === "cooldown" && acc.cooldownUntil && acc.cooldownUntil <= now) {
        accountService.setEnabled(acc.id);
        this.retryCounts.delete(acc.id);
      }
    }

    const active = accountService.list().filter((a) => a.status === "active");
    if (active.length === 0) {
      this._lastFailReason = "no_active";
      return null;
    }

    let pickedId: string;
    const strategy = this.getStrategy();
    if (strategy === "lowest-usage") {
      pickedId = this.pickLowestUsage(active);
    } else if (strategy === "fill-first") {
      const sorted = [...active].sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
      pickedId = sorted[0]!.id;
    } else {
      // Round-robin
      this.cursor = this.cursor % active.length;
      pickedId = active[this.cursor]!.id;
      this.cursor = (this.cursor + 1) % active.length;
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
    const active = accountService.list().filter(
      (a) => a.status === "active" || (a.status === "cooldown" && (a.cooldownUntil ?? 0) <= now),
    );
    if (active.length === 0) return null;

    const strategy = this.getStrategy();
    let pickedId: string;
    if (strategy === "lowest-usage") {
      pickedId = this.pickLowestUsage(active);
    } else if (strategy === "fill-first") {
      const sorted = [...active].sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
      pickedId = sorted[0]!.id;
    } else {
      const idx = this.cursor % active.length;
      pickedId = active[idx]!.id;
    }
    return accountService.getWithTokens(pickedId);
  }

  /**
   * Weighted sustainability score.
   * Considers 5-hour utilization, weekly utilization, and time until weekly reset.
   *
   * score = 0.35 × (1 - 5hr) + 0.65 × min(weeklyRemaining / resetRatio, 1.0)
   *
   * weeklyRemaining / resetRatio normalizes remaining capacity by time until reset:
   *  - 4% remaining with 34h left  → low sustainability (0.20)
   *  - 78% remaining with 113h left → high sustainability (1.0, capped)
   *  - 20% remaining with 6h left   → decent (resets soon, so it's fine)
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
      const sustainability = Math.min(weeklyRemaining / Math.max(resetRatio, 0.05), 1.0);
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
    const backoffMs = Math.min(BACKOFF_BASE_MS * Math.pow(2, retries - 1), BACKOFF_MAX_MS);
    const cooldownUntilMs = Date.now() + backoffMs;
    accountService.setCooldown(accountId, cooldownUntilMs);
    console.log(`[accounts] ${accountId} rate limited — cooldown ${Math.round(backoffMs / 1000)}s (retry #${retries})`);
  }

  /** Called when auth error (401 / authentication_failed) — cooldown with longer backoff */
  onAuthError(accountId: string): void {
    const retries = (this.retryCounts.get(accountId) ?? 0) + 1;
    this.retryCounts.set(accountId, retries);
    const backoffMs = Math.min(AUTH_BACKOFF_BASE_MS * Math.pow(2, retries - 1), BACKOFF_MAX_MS);
    accountService.setCooldown(accountId, Date.now() + backoffMs);
    console.log(`[accounts] ${accountId} auth error — cooldown ${Math.round(backoffMs / 1000)}s (retry #${retries})`);
  }

  /** Called on successful request — reset retry count + track usage */
  onSuccess(accountId: string): void {
    this.retryCounts.delete(accountId);
    accountService.trackUsage(accountId);
  }

  /** How many accounts are active or have expired cooldowns right now */
  activeCount(): number {
    const now = Math.floor(Date.now() / 1000);
    return accountService.list().filter(
      (a) => a.status === "active" || (a.status === "cooldown" && (a.cooldownUntil ?? 0) <= now),
    ).length;
  }

  /** True if multi-account mode is enabled (≥1 account in DB) */
  isEnabled(): boolean {
    return accountService.list().length > 0;
  }
}

export const accountSelector = new AccountSelectorService();
