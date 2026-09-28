import type { UsageInfo } from "../../types/chat.ts";
import type { ProviderUsageSource } from "../../services/provider-usage/usage-source.ts";
import { AMBIENT_ACCOUNT_KEY } from "../../services/provider-usage/usage-source.ts";
import { listCodexAccounts, getCodexAccount } from "../../services/codex-account.service.ts";
import { fetchCodexUsageLive } from "./codex-usage-fetch.ts";
import { isCodexAuthFailure } from "./codex-auth-failure.ts";
import { markCodexAccountAuthFailed, clearCodexAccountAuthFailure } from "../../services/codex-account-auth-state.ts";

/**
 * Codex's plug into the shared usage layer.
 *
 * All this has to say is which accounts exist and how to read one; the sweep,
 * the timeout, the cache, and the snapshot persistence come from the layer.
 * Before it existed, codex had a lazy 60-second memory cache and no sweep at
 * all, so every read that missed spawned an app-server on the request path.
 */
export const codexUsageSource: ProviderUsageSource = {
  providerId: "codex",

  listAccountIds(): string[] {
    return listCodexAccounts().map((a) => a.id);
  },

  async fetch(accountId: string): Promise<UsageInfo> {
    // No managed accounts configured — read whatever login `~/.codex` holds.
    if (accountId === AMBIENT_ACCOUNT_KEY) return fetchCodexUsageLive();

    const account = getCodexAccount(accountId);
    // The account was removed between the sweep listing it and this fetch.
    // Throwing (rather than returning {}) keeps it out of the store: an empty
    // object would be persisted as a real reading for an account that is gone.
    if (!account) throw new Error(`codex account ${accountId} no longer exists`);

    let usage: UsageInfo;
    try {
      usage = await fetchCodexUsageLive(account.home);
    } catch (e) {
      // The sweep is the one thing that reads every account on a timer, so it is what keeps
      // a signed-out account benched between turns — and what notices it first, before any
      // turn is spent on it.
      const message = (e as Error)?.message ?? String(e);
      if (isCodexAuthFailure(message)) markCodexAccountAuthFailed(account.id, message.slice(0, 256));
      throw e;
    }
    clearCodexAccountAuthFailure(account.id);
    // The rate-limit payload carries the plan name, which the parser puts in
    // activeAccountLabel; the account's own label is the truthful one.
    return { ...usage, activeAccountId: account.id, activeAccountLabel: account.label };
  },
};
