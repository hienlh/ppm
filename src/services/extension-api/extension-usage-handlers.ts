/**
 * `ppm.usage.get()` and `ppm.presence.get()` — read-only, and fast enough that neither needs
 * the call registry `ai:complete` uses: there is nothing here to cancel or abort a worker
 * rebuild mid-flight.
 *
 * Usage never forces a refresh. Claude's reading is a DB/memory read (`getAllAccountUsages`);
 * Codex's (`getAllCodexUsages`) fetches live only on a cold miss — the shared usage-polling
 * layer's own rule, not something this handler adds to or works around.
 */
import type { RpcChannel } from "../extension-rpc.ts";
import { getAllAccountUsages } from "../claude-usage.service.ts";
import { listCodexAccounts, getAllCodexUsages } from "../codex-account.service.ts";
import { buildUsageSummary, type UsageAccountSource } from "./extension-usage-summary.ts";
import { presenceTracker, type PresenceSnapshot } from "../presence-tracker.ts";

/** Seam for tests: swap every live source for a fixture without mocking whole modules. */
export interface ExtensionUsageDeps {
  claudeAccounts(): UsageAccountSource[];
  codexAccounts(): Promise<UsageAccountSource[]>;
  presence(): PresenceSnapshot;
}

export const defaultExtensionUsageDeps: ExtensionUsageDeps = {
  claudeAccounts: () => getAllAccountUsages().map((entry) => ({
    provider: "claude",
    accountId: entry.accountId,
    status: entry.accountStatus,
    usage: entry.usage,
  })),

  codexAccounts: async () => {
    const accounts = listCodexAccounts();
    if (accounts.length === 0) return [];
    const usages = await getAllCodexUsages();
    return accounts.map((account) => ({
      provider: "codex" as const,
      accountId: account.id,
      status: account.status,
      usage: usages[account.id] ?? {},
    }));
  },

  presence: () => presenceTracker.presence(Date.now()),
};

export function registerExtensionUsageHandlers(rpc: RpcChannel, deps: ExtensionUsageDeps = defaultExtensionUsageDeps): void {
  rpc.onRequest("usage:get", async () => {
    const accounts = [...deps.claudeAccounts(), ...(await deps.codexAccounts())];
    return buildUsageSummary(Date.now(), accounts);
  });

  rpc.onRequest("presence:get", async () => deps.presence());
}
