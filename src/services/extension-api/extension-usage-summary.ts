/**
 * `ppm.usage.get()`'s pure half: turns PPM's internal usage readings into the
 * extension-facing shape. No network, no DB — the caller (`extension-usage-handlers.ts`)
 * reads the live accounts and hands over plain data.
 *
 * What never leaves this module: email, profile data, tokens, home paths, and the account's
 * own `label` (a Codex label can be an email; an auto-generated Claude label can be a person's
 * name). The output's only identifiers are PPM's internal account id and a neutral alias
 * ("Claude 1", "Codex 2", ...) assigned by the order accounts were given in.
 */
import type { LimitBucket, ScopedLimitBucket } from "../../types/chat.ts";

export type UsageProviderId = "claude" | "codex";

/** The only fields this mapper reads. Both `ClaudeUsage` and Codex's `UsageInfo` satisfy it. */
export interface MappableUsage {
  session?: LimitBucket;
  weekly?: LimitBucket;
  weeklyOpus?: LimitBucket;
  weeklySonnet?: LimitBucket;
  weeklyScoped?: ScopedLimitBucket[];
  lastFetchedAt?: string;
}

export interface UsageAccountSource {
  provider: UsageProviderId;
  accountId: string;
  /** The account's own status (e.g. "active" | "cooldown" | "disabled"); never its label. */
  status: string;
  usage: MappableUsage;
}

export interface UsageWindow {
  usedPct: number;
  resetsAt: string | null;
  resetsInMs: number | null;
}

export interface UsageAccountSummary {
  provider: UsageProviderId;
  accountId: string;
  alias: string;
  status: string;
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
  weeklyByModel?: Array<UsageWindow & { label: string }>;
  fetchedAt: string | null;
  ageMs: number | null;
}

export interface UsageSummary {
  now: string;
  accounts: UsageAccountSummary[];
}

function roundPct(utilization: number): number {
  return Math.round(utilization * 1000) / 10;
}

/** `""` (Claude's "no reset time") and an unparsable string both become "unknown", not "now". */
function parseMs(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * A reset time already in the past means the window rolled over and the next poll will say
 * so; `usedPct` is still reported (it is the last reading we have), but `resetsAt`/`resetsInMs`
 * go to null rather than a negative duration or a stale timestamp.
 */
function mapWindow(bucket: LimitBucket | undefined, nowMs: number): UsageWindow | undefined {
  if (!bucket) return undefined;
  const resetMs = parseMs(bucket.resetsAt);
  const future = resetMs != null && resetMs > nowMs;
  return {
    usedPct: roundPct(bucket.utilization),
    resetsAt: future ? new Date(resetMs as number).toISOString() : null,
    resetsInMs: future ? (resetMs as number) - nowMs : null,
  };
}

/** Claude's per-model weekly caps (Opus, Sonnet, and any `weeklyScoped` model); absent for Codex. */
function mapWeeklyByModel(usage: MappableUsage, nowMs: number): Array<UsageWindow & { label: string }> | undefined {
  const rows: Array<UsageWindow & { label: string }> = [];
  const opus = mapWindow(usage.weeklyOpus, nowMs);
  if (opus) rows.push({ ...opus, label: "Opus" });
  const sonnet = mapWindow(usage.weeklySonnet, nowMs);
  if (sonnet) rows.push({ ...sonnet, label: "Sonnet" });
  for (const scoped of usage.weeklyScoped ?? []) {
    const mapped = mapWindow(scoped, nowMs);
    if (mapped) rows.push({ ...mapped, label: scoped.label });
  }
  return rows.length ? rows : undefined;
}

function aliasFor(provider: UsageProviderId, index: number): string {
  return `${provider === "claude" ? "Claude" : "Codex"} ${index + 1}`;
}

/** Pure: `accounts` is in the stable order the caller listed them, one entry per account
 *  (disabled accounts included — the extension decides whether to skip them). */
export function buildUsageSummary(nowMs: number, accounts: UsageAccountSource[]): UsageSummary {
  const nextIndex: Record<UsageProviderId, number> = { claude: 0, codex: 0 };
  return {
    now: new Date(nowMs).toISOString(),
    accounts: accounts.map((account): UsageAccountSummary => {
      const alias = aliasFor(account.provider, nextIndex[account.provider]++);
      const fetchedMs = parseMs(account.usage.lastFetchedAt);
      const fiveHour = mapWindow(account.usage.session, nowMs);
      const weekly = mapWindow(account.usage.weekly, nowMs);
      const weeklyByModel = mapWeeklyByModel(account.usage, nowMs);
      return {
        provider: account.provider,
        accountId: account.accountId,
        alias,
        status: account.status,
        ...(fiveHour ? { fiveHour } : {}),
        ...(weekly ? { weekly } : {}),
        ...(weeklyByModel ? { weeklyByModel } : {}),
        fetchedAt: fetchedMs != null ? new Date(fetchedMs).toISOString() : null,
        ageMs: fetchedMs != null ? nowMs - fetchedMs : null,
      };
    }),
  };
}
