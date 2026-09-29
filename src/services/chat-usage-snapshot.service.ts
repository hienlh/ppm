import { providerRegistry } from "../providers/registry.ts";
import { getCachedUsage } from "./claude-usage.service.ts";
import { getSessionAccount } from "./db.service.ts";
import type { UsageInfo } from "../types/chat.ts";

/** `getCachedUsage`'s extra field, carried through so a prepare response can show it too. */
export interface ChatUsageSnapshot extends UsageInfo {
  lastFetchedAt?: string;
}

export interface UsageSnapshotOptions {
  sessionId?: string;
  accountId?: string;
}

/**
 * Usage for a provider, extracted from `GET /chat/usage` so `/chat/prepare` can read the
 * same snapshot for the account it just picked, before any session exists to bind it.
 *
 * Claude reads the session's bound account when there is one, and falls back to `accountId`
 * only when there is no session — a session's binding is the authoritative answer once it
 * exists, and a client-supplied id must never override it.
 */
export async function readUsageSnapshot(
  providerId: string | undefined,
  opts: UsageSnapshotOptions = {},
): Promise<ChatUsageSnapshot> {
  if (providerId && providerId !== "claude") {
    const provider = providerRegistry.get(providerId);
    if (provider?.getUsage) {
      try { return await provider.getUsage(opts.sessionId, opts.accountId); } catch { return {}; }
    }
    return {};
  }
  const effectiveAccountId = opts.sessionId ? getSessionAccount(opts.sessionId) : opts.accountId;
  const usage = getCachedUsage(effectiveAccountId ?? undefined);
  return {
    lastFetchedAt: usage.lastFetchedAt,
    fiveHour: usage.session?.utilization,
    sevenDay: usage.weekly?.utilization,
    fiveHourResetsAt: usage.session?.resetsAt,
    sevenDayResetsAt: usage.weekly?.resetsAt,
    session: usage.session,
    weekly: usage.weekly,
    weeklyOpus: usage.weeklyOpus,
    weeklySonnet: usage.weeklySonnet,
    weeklyScoped: usage.weeklyScoped,
    totalCostUsd: usage.totalCostUsd,
    activeAccountId: usage.activeAccountId,
    activeAccountLabel: usage.activeAccountLabel,
  };
}
