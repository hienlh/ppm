import type { RpcClient } from "../types.ts";

/**
 * `api.ppm.usage` and `api.ppm.presence` — read-only quota and "is a person at this PPM right
 * now" signals. Both are fast reads the main thread answers from memory/DB
 * (`src/services/extension-api/extension-usage-handlers.ts`), so neither needs a call id or a
 * cancel path the way `api.ppm.ai` does.
 *
 * Usage carries no email, profile, token, home path or account label — only PPM's internal
 * account id and a neutral alias ("Claude 1", "Codex 2", ...). Presence carries no content,
 * only a timestamp, and is a signal to pause/not-propose a run — never a permission to spend.
 */

export type PpmUsageProviderId = "claude" | "codex";

export interface PpmUsageWindow {
  usedPct: number;
  resetsAt: string | null;
  resetsInMs: number | null;
}

export interface PpmUsageAccount {
  provider: PpmUsageProviderId;
  accountId: string;
  alias: string;
  status: string;
  fiveHour?: PpmUsageWindow;
  weekly?: PpmUsageWindow;
  weeklyByModel?: Array<PpmUsageWindow & { label: string }>;
  fetchedAt: string | null;
  ageMs: number | null;
}

export interface PpmUsageSummary {
  now: string;
  accounts: PpmUsageAccount[];
}

export interface PpmUsage {
  get(): Promise<PpmUsageSummary>;
}

export function createPpmUsage(rpc: RpcClient): PpmUsage {
  return { get: () => rpc.request<PpmUsageSummary>("usage:get") };
}

export interface PpmPresenceSnapshot {
  lastInputAt: string | null;
  idleMs: number | null;
  active: boolean;
  activeWindowMs: number;
}

export interface PpmPresence {
  get(): Promise<PpmPresenceSnapshot>;
}

export function createPpmPresence(rpc: RpcClient): PpmPresence {
  return { get: () => rpc.request<PpmPresenceSnapshot>("presence:get") };
}
