import { accountService, type AccountWithTokens } from "./account.service.ts";
import { getConfigValue, setConfigValue } from "./db.service.ts";

export type AccountStrategy = "round-robin" | "fill-first";

const STRATEGY_CONFIG_KEY = "account_strategy";
const MAX_RETRY_CONFIG_KEY = "account_max_retry";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30 * 60_000;

class AccountSelectorService {
  private cursor = 0;
  private retryCounts = new Map<string, number>();

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
   * Pick next available account (skips cooldown/disabled).
   * Returns null if no active accounts available.
   */
  next(): AccountWithTokens | null {
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
    if (active.length === 0) return null;

    if (this.getStrategy() === "fill-first") {
      const sorted = [...active].sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
      return accountService.getWithTokens(sorted[0].id);
    }

    // Round-robin
    this.cursor = this.cursor % active.length;
    const picked = active[this.cursor];
    this.cursor = (this.cursor + 1) % active.length;
    return accountService.getWithTokens(picked.id);
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

  /** Called when 401 Unauthorized — disable account */
  onAuthError(accountId: string): void {
    console.log(`[accounts] ${accountId} auth error — disabling account`);
    accountService.setDisabled(accountId);
    this.retryCounts.delete(accountId);
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
