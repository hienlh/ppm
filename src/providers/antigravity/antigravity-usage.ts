import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LimitBucket, ScopedLimitBucket, UsageInfo } from "../../types/chat.ts";
import { AMBIENT_ACCOUNT_KEY, type ProviderUsageSource } from "../../services/provider-usage/usage-source.ts";
import {
  ensureLanguageServerConnection,
  type LanguageServerConnection,
} from "./antigravity-connection.ts";
import {
  clearAntigravityAccountAuthFailure,
  formatAntigravityAccountLabel,
  getAntigravityAccount,
  listAntigravityAccounts,
  markAntigravityAccountAuthFailed,
  updateAntigravityAccountMeta,
} from "../../services/antigravity-account.service.ts";

interface QuotaBucketRaw {
  bucketId?: string;
  displayName?: string;
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
}

interface QuotaGroupRaw {
  displayName?: string;
  buckets?: QuotaBucketRaw[];
}

interface RetrieveUserQuotaSummaryRaw {
  response?: {
    groups?: QuotaGroupRaw[];
  };
}

interface GetUserStatusRaw {
  userStatus?: {
    name?: string;
    email?: string;
    userTier?: {
      id?: string;
      name?: string;
      description?: string;
    };
    planStatus?: {
      planInfo?: {
        planName?: string;
        teamsTier?: string;
      };
    };
  };
}

function resolveUserPlanName(user?: GetUserStatusRaw["userStatus"]): string | undefined {
  return user?.userTier?.name?.trim() || user?.planStatus?.planInfo?.planName?.trim() || undefined;
}

export interface AntigravityAccountInfo {
  connected: boolean;
  name?: string;
  email?: string;
  planName?: string;
  teamsTier?: string;
  usage: UsageInfo;
  error?: string;
}

function clamp01(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.max(0, Math.min(1, val));
}

function toLimitBucket(remainingFraction: number | undefined, resetTime: string | undefined, windowHours: number): LimitBucket | undefined {
  if (typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction)) return undefined;
  const utilization = clamp01(1 - remainingFraction);
  const resetsAt = typeof resetTime === "string" ? resetTime : "";
  let resetsInMinutes: number | null = null;
  if (resetsAt) {
    const ms = Date.parse(resetsAt) - Date.now();
    if (Number.isFinite(ms)) {
      resetsInMinutes = Math.max(0, Math.round(ms / 60_000));
    }
  }
  return {
    utilization,
    resetsAt,
    resetsInMinutes,
    resetsInHours: resetsInMinutes != null ? Math.round((resetsInMinutes / 60) * 10) / 10 : null,
    windowHours,
  };
}

async function callLsRpc<T>(conn: LanguageServerConnection, method: string, timeoutMs = 4000): Promise<T | null> {
  const res = await fetch(
    `http://${conn.address}/exa.language_server_pb.LanguageServerService/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-codeium-csrf-token": conn.csrfToken,
      },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!res.ok) return null;
  return (await res.json()) as T;
}

/** Parse raw Antigravity `RetrieveUserQuotaSummary` + `GetUserStatus` payloads into PPM `UsageInfo`. */
export function parseAntigravityUsage(
  quotaRaw: RetrieveUserQuotaSummaryRaw | null | undefined,
  statusRaw?: GetUserStatusRaw | null,
): UsageInfo {
  const out: UsageInfo = {};
  const groups = quotaRaw?.response?.groups ?? [];

  const scoped: ScopedLimitBucket[] = [];

  for (const group of groups) {
    const isGemini = (group.displayName ?? "").toLowerCase().includes("gemini") || groups.indexOf(group) === 0;
    for (const b of group.buckets ?? []) {
      const isWeekly = b.window === "weekly" || (b.bucketId ?? "").includes("weekly");
      const bucket = toLimitBucket(b.remainingFraction, b.resetTime, isWeekly ? 168 : 5);
      if (!bucket) continue;

      if (isGemini) {
        if (isWeekly) {
          out.sevenDay = bucket.utilization;
          out.sevenDayResetsAt = bucket.resetsAt || undefined;
          out.weekly = bucket;
        } else {
          out.fiveHour = bucket.utilization;
          out.fiveHourResetsAt = bucket.resetsAt || undefined;
          out.session = bucket;
        }
      } else {
        const groupLabel = group.displayName || "Other Models";
        const winLabel = isWeekly ? "Weekly" : "5-Hour";
        scoped.push({
          ...bucket,
          label: `${groupLabel} · ${winLabel}`,
        });
      }
    }
  }

  if (scoped.length > 0) {
    out.weeklyScoped = scoped;
  }

  const user = statusRaw?.userStatus;
  if (user) {
    const name = user.name?.trim() || user.email?.trim();
    const plan = resolveUserPlanName(user);
    if (name) {
      out.activeAccountLabel = plan ? `${name} · ${plan}` : name;
    } else if (plan) {
      out.activeAccountLabel = `Antigravity ${plan}`;
    }
    if (user.email) {
      out.activeAccountId = user.email;
    }
  }

  return out;
}

/** Fetch live quota & account status from the running Antigravity Language Server. */
export async function fetchAntigravityUsageLive(customHome?: string): Promise<UsageInfo> {
  const conn = await ensureLanguageServerConnection(customHome);
  if (!conn) {
    throw new Error("Antigravity Language Server connection not available");
  }

  const [quotaRaw, statusRaw] = await Promise.all([
    callLsRpc<RetrieveUserQuotaSummaryRaw>(conn, "RetrieveUserQuotaSummary"),
    callLsRpc<GetUserStatusRaw>(conn, "GetUserStatus").catch(() => null),
  ]);

  if (!quotaRaw?.response?.groups?.length) {
    throw new Error("Antigravity RetrieveUserQuotaSummary returned no quota groups");
  }

  return parseAntigravityUsage(quotaRaw, statusRaw);
}

/** Fetch live account profile + quota status for the Settings -> Accounts -> Antigravity pane. */
export async function fetchAntigravityAccountStatus(customHome?: string): Promise<AntigravityAccountInfo> {
  const conn = await ensureLanguageServerConnection(customHome);
  if (!conn) {
    return {
      connected: false,
      usage: {},
      error: "Antigravity Language Server is not running. Start Antigravity Desktop or sign in via agy.",
    };
  }

  try {
    const [quotaRaw, statusRaw] = await Promise.all([
      callLsRpc<RetrieveUserQuotaSummaryRaw>(conn, "RetrieveUserQuotaSummary").catch(() => null),
      callLsRpc<GetUserStatusRaw>(conn, "GetUserStatus").catch(() => null),
    ]);
    const user = statusRaw?.userStatus;
    const hasQuota = Boolean(quotaRaw?.response?.groups?.length);
    if (!user && !hasQuota) {
      return {
        connected: false,
        usage: {},
        error: "Unable to read account status from Antigravity Language Server.",
      };
    }
    const usage = parseAntigravityUsage(quotaRaw, statusRaw);
    return {
      connected: true,
      name: user?.name?.trim() || undefined,
      email: user?.email?.trim() || undefined,
      planName: resolveUserPlanName(user),
      teamsTier: user?.userTier?.id?.trim() || user?.planStatus?.planInfo?.teamsTier?.trim() || undefined,
      usage,
    };
  } catch (e) {
    return {
      connected: false,
      usage: {},
      error: (e as Error).message,
    };
  }
}

export const antigravityUsageSource: ProviderUsageSource = {
  providerId: "antigravity",
  listAccountIds(): string[] {
    return listAntigravityAccounts().map((a) => a.id);
  },
  async fetch(accountId = AMBIENT_ACCOUNT_KEY): Promise<UsageInfo> {
    if (accountId === AMBIENT_ACCOUNT_KEY) {
      return fetchAntigravityUsageLive();
    }
    const account = getAntigravityAccount(accountId);
    if (!account) {
      throw new Error(`Antigravity account ${accountId} no longer exists`);
    }
    if (account.home && !existsSync(join(account.home, ".gemini", "jetski-standalone-oauth-token"))) {
      markAntigravityAccountAuthFailed(account.id, "OAuth token file missing");
      throw new Error("Antigravity account is signed out");
    }
    const status = await fetchAntigravityAccountStatus(account.home || undefined);
    if (!status.connected) {
      throw new Error(status.error || "Unable to fetch Antigravity account quota");
    }
    clearAntigravityAccountAuthFailure(account.id);
    if (status.email || status.planName) {
      updateAntigravityAccountMeta(account.id, {
        ...(status.email ? { email: status.email } : {}),
        ...(status.planName ? { planType: status.planName } : {}),
      });
    }
    const updated = getAntigravityAccount(account.id) ?? account;
    return {
      ...status.usage,
      activeAccountId: updated.id,
      activeAccountLabel: formatAntigravityAccountLabel(updated),
    };
  },
};
