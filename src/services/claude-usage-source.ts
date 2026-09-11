import type { UsageInfo } from "../types/chat.ts";
import type { ProviderUsageSource } from "./provider-usage/usage-source.ts";
import { AMBIENT_ACCOUNT_KEY } from "./provider-usage/usage-source.ts";
import { accountService } from "./account.service.ts";
import {
  fetchClaudeAccountUsage,
  fetchLegacyClaudeUsage,
  shouldSkipClaudeAccount,
} from "./claude-usage.service.ts";

/**
 * Claude's plug into the shared usage layer.
 *
 * Everything Claude-specific stays in `claude-usage.service`: OAuth token
 * refresh, the post-429 cooldown, the Keychain fallback for installs that never
 * added an account. What this adapter removes is the second copy of the generic
 * machinery — Claude used to own its own poll timer, stagger, in-flight dedup,
 * and persistence, all of which now come from the layer and are shared with
 * codex.
 */
export const claudeUsageSource: ProviderUsageSource = {
  providerId: "claude",

  listAccountIds(): string[] {
    // Empty means no account store, and the layer falls back to the ambient
    // login — which is exactly the legacy single-login install.
    return accountService.list().map((a) => a.id);
  },

  shouldSkip(accountId: string): Promise<boolean> {
    // The ambient login has no account row to consult, so nothing to skip on.
    if (accountId === AMBIENT_ACCOUNT_KEY) return Promise.resolve(false);
    return shouldSkipClaudeAccount(accountId);
  },

  async fetch(accountId: string): Promise<UsageInfo> {
    if (accountId === AMBIENT_ACCOUNT_KEY) return fetchLegacyClaudeUsage();
    return fetchClaudeAccountUsage(accountId);
  },
};
