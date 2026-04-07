import { homedir } from "node:os";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  insertLimitSnapshot,
  getLatestLimitSnapshot,
  getLatestSnapshotForAccount,
  getAllLatestSnapshots,
  cleanupOldLimitSnapshots,
  touchSnapshotTimestamp,
  type LimitSnapshotRow,
} from "./db.service.ts";
import { accountService } from "./account.service.ts";
import { decrypt } from "../lib/account-crypto.ts";
import { accountSelector } from "./account-selector.service.ts";

export interface LimitBucket {
  utilization: number;
  resetsAt: string;
  resetsInMinutes: number | null;
  resetsInHours: number | null;
  windowHours: number;
}

export interface ClaudeUsage {
  lastFetchedAt?: string;
  session?: LimitBucket;
  weekly?: LimitBucket;
  weeklyOpus?: LimitBucket;
  weeklySonnet?: LimitBucket;
  totalCostUsd?: number;
}

export interface AccountUsageEntry {
  accountId: string;
  accountLabel: string | null;
  accountStatus: string;
  isOAuth: boolean;
  usage: ClaudeUsage;
}

const API_URL = "https://api.anthropic.com/api/oauth/usage";
const API_BETA = "oauth-2025-04-20";
const USER_AGENT = "claude-code/1.0";
const FETCH_TIMEOUT = 10_000;
const POLL_INTERVAL = 300_000; // 5min
const ACCOUNT_STAGGER_MS = 1_000; // 1s between accounts

let inMemoryCostUsd = 0;

// Survive Bun --hot reloads: module-level vars reset on reload, globalThis persists.
// Without this, each hot-reload creates a NEW polling timer without clearing the old one,
// leading to N concurrent timers after N reloads (observed: 221 timers → 38k 429 errors/day).
const HOT_KEY = "__PPM_USAGE_POLL__" as const;
const hotState = ((globalThis as any)[HOT_KEY] ??= {
  pollTimer: null as ReturnType<typeof setTimeout> | null,
  inflightPoll: null as Promise<void> | null,
}) as { pollTimer: ReturnType<typeof setTimeout> | null; inflightPoll: Promise<void> | null };

// Per-token cooldown map: token prefix → earliest allowed fetch time
const tokenCooldowns = new Map<string, number>();
const MIN_COOLDOWN_MS = 60_000; // floor: at least 60s cooldown on 429

// Legacy: Keychain token cache for users without accounts in DB
let tokenCache: { token: string; timestamp: number } | null = null;
const TOKEN_TTL = 300_000;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseApiBucket(raw: Record<string, any>, windowHours: number): LimitBucket {
  const utilization = (raw.utilization ?? 0) / 100;
  const resetsAt = raw.resets_at ?? "";
  const diff = resetsAt ? new Date(resetsAt).getTime() - Date.now() : 0;
  const totalMins = diff > 0 ? Math.ceil(diff / 60_000) : 0;
  return {
    utilization,
    resetsAt,
    resetsInMinutes: windowHours <= 5 ? totalMins : null,
    resetsInHours: windowHours > 5 ? Math.round((totalMins / 60) * 100) / 100 : null,
    windowHours,
  };
}

function dbBucketToLimitBucket(util: number, resetsAt: string, windowHours: number): LimitBucket {
  const diff = resetsAt ? new Date(resetsAt).getTime() - Date.now() : 0;
  const totalMins = diff > 0 ? Math.ceil(diff / 60_000) : 0;
  return {
    utilization: util,
    resetsAt,
    resetsInMinutes: windowHours <= 5 ? totalMins : null,
    resetsInHours: windowHours > 5 ? Math.round((totalMins / 60) * 100) / 100 : null,
    windowHours,
  };
}

function snapshotToUsage(row: LimitSnapshotRow): ClaudeUsage {
  // SQLite datetime('now') returns UTC without Z suffix — JS would parse as local time
  const utcTimestamp = row.recorded_at.endsWith("Z") ? row.recorded_at : row.recorded_at.replace(" ", "T") + "Z";
  const result: ClaudeUsage = { lastFetchedAt: utcTimestamp };
  if (row.five_hour_util != null) result.session = dbBucketToLimitBucket(row.five_hour_util, row.five_hour_resets_at ?? "", 5);
  if (row.weekly_util != null) result.weekly = dbBucketToLimitBucket(row.weekly_util, row.weekly_resets_at ?? "", 168);
  if (row.weekly_opus_util != null) result.weeklyOpus = dbBucketToLimitBucket(row.weekly_opus_util, row.weekly_opus_resets_at ?? "", 168);
  if (row.weekly_sonnet_util != null) result.weeklySonnet = dbBucketToLimitBucket(row.weekly_sonnet_util, row.weekly_sonnet_resets_at ?? "", 168);
  return result;
}

// ---------------------------------------------------------------------------
// Fetch usage for a single token
// ---------------------------------------------------------------------------

async function fetchUsageForToken(token: string): Promise<ClaudeUsage> {
  const res = await fetch(API_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-beta": API_BETA,
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
    const cooldownMs = Math.max(retryAfter * 1000, MIN_COOLDOWN_MS);
    const cooldownKey = token.substring(0, 20);
    tokenCooldowns.set(cooldownKey, Date.now() + cooldownMs);
    throw new Error(`Usage API 429 — cooldown ${Math.ceil(cooldownMs / 1000)}s`);
  }
  if (!res.ok) throw new Error(`Usage API returned ${res.status}`);
  const raw = (await res.json()) as Record<string, any>;
  const data: ClaudeUsage = { lastFetchedAt: new Date().toISOString() };
  if (raw.five_hour) data.session = parseApiBucket(raw.five_hour, 5);
  if (raw.seven_day) data.weekly = parseApiBucket(raw.seven_day, 168);
  if (raw.seven_day_opus) data.weeklyOpus = parseApiBucket(raw.seven_day_opus, 168);
  if (raw.seven_day_sonnet) data.weeklySonnet = parseApiBucket(raw.seven_day_sonnet, 168);
  return data;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function hasChanged(data: ClaudeUsage, last: LimitSnapshotRow | null): boolean {
  if (!last) return true;
  const d = (a: number | null | undefined, b: number | null) =>
    a != null && (b == null || Math.abs(a - b) > 0.001);
  if (d(data.session?.utilization, last.five_hour_util)) return true;
  if (d(data.weekly?.utilization, last.weekly_util)) return true;
  if (data.session?.resetsAt && data.session.resetsAt !== (last.five_hour_resets_at ?? "")) return true;
  if (data.weekly?.resetsAt && data.weekly.resetsAt !== (last.weekly_resets_at ?? "")) return true;
  return false;
}

function persistIfChanged(data: ClaudeUsage, accountId: string | null): void {
  const last = accountId ? getLatestSnapshotForAccount(accountId) : getLatestLimitSnapshot();
  if (!hasChanged(data, last)) {
    // Data unchanged but still update timestamp so "last fetched" is accurate
    if (accountId) touchSnapshotTimestamp(accountId);
    return;
  }
  insertLimitSnapshot({
    account_id: accountId,
    five_hour_util: data.session?.utilization ?? null,
    five_hour_resets_at: data.session?.resetsAt ?? null,
    weekly_util: data.weekly?.utilization ?? null,
    weekly_resets_at: data.weekly?.resetsAt ?? null,
    weekly_opus_util: data.weeklyOpus?.utilization ?? null,
    weekly_opus_resets_at: data.weeklyOpus?.resetsAt ?? null,
    weekly_sonnet_util: data.weeklySonnet?.utilization ?? null,
    weekly_sonnet_resets_at: data.weeklySonnet?.resetsAt ?? null,
  });
  cleanupOldLimitSnapshots();
}

// ---------------------------------------------------------------------------
// Multi-account polling
// ---------------------------------------------------------------------------

async function fetchAllAccountUsages(): Promise<void> {
  const accounts = accountService.list();
  const nowS = Math.floor(Date.now() / 1000);
  for (const acc of accounts) {
    if (acc.status === "disabled") continue;
    // Skip expired temporary accounts (no refresh token)
    if (!accountService.hasRefreshToken(acc.id) && acc.expiresAt && acc.expiresAt < nowS) continue;
    // Ensure token is fresh before calling usage API (prevents 401 from expired tokens)
    const withTokens = await accountService.ensureFreshToken(acc.id);
    if (!withTokens) continue;
    const token = withTokens.accessToken;
    // Only OAuth tokens have usage endpoint
    if (!token.startsWith("sk-ant-oat")) continue;
    // Check cooldown from previous 429
    const cooldownKey = token.substring(0, 20);
    const cooldownUntil = tokenCooldowns.get(cooldownKey);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      const secs = Math.ceil((cooldownUntil - Date.now()) / 1000);
      console.log(`[usage] ${acc.label ?? acc.id}: rate-limited, ${secs}s remaining`);
      continue;
    }
    try {
      const data = await fetchUsageForToken(token);
      tokenCooldowns.delete(cooldownKey); // clear cooldown on success
      persistIfChanged(data, acc.id);
    } catch (e) {
      console.error(`[usage] ${acc.label ?? acc.id}:`, (e as Error).message);
    }
    if (accounts.length > 1) await new Promise(r => setTimeout(r, ACCOUNT_STAGGER_MS));
  }
}

// Legacy: Keychain-based single-token fetch (no accounts in DB)
function getLegacyAccessToken(): string | null {
  if (tokenCache && Date.now() - tokenCache.timestamp < TOKEN_TTL) return tokenCache.token;
  let creds: Record<string, any> | null = null;
  if (process.platform === "darwin") {
    try {
      const proc = Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]);
      if (proc.exitCode === 0) creds = JSON.parse(proc.stdout.toString().trim());
    } catch {}
  }
  if (!creds) {
    const credPath = resolve(homedir(), ".claude", ".credentials.json");
    if (existsSync(credPath)) creds = JSON.parse(readFileSync(credPath, "utf-8"));
  }
  const token = creds?.claudeAiOauth?.accessToken;
  if (!token) return null;
  tokenCache = { token, timestamp: Date.now() };
  return token;
}

async function fetchLegacySingleAccount(): Promise<void> {
  const token = getLegacyAccessToken();
  if (!token) return;
  try {
    const data = await fetchUsageForToken(token);
    persistIfChanged(data, null);
  } catch {}
}

async function pollOnceInternal(): Promise<void> {
  try {
    const hasAccounts = accountService.list().length > 0;
    if (hasAccounts) {
      await fetchAllAccountUsages();
    } else {
      await fetchLegacySingleAccount();
    }
  } catch (e) {
    console.error("[usage] pollOnce error:", (e as Error).message);
  }
}

/** Deduped: concurrent callers share a single in-flight fetch */
async function pollOnce(): Promise<void> {
  if (hotState.inflightPoll) return hotState.inflightPoll;
  const thisPoll = pollOnceInternal().finally(() => {
    // Only clear if still the current poll — prevents a stale .finally() from
    // clearing a newer poll after timeout handler force-nulled inflightPoll.
    if (hotState.inflightPoll === thisPoll) hotState.inflightPoll = null;
  });
  hotState.inflightPoll = thisPoll;
  return thisPoll;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get usage for specific account */
export function getUsageForAccount(accountId: string): ClaudeUsage {
  const row = getLatestSnapshotForAccount(accountId);
  return row ? snapshotToUsage(row) : {};
}

/** Get usage for all accounts */
export function getAllAccountUsages(): AccountUsageEntry[] {
  const accounts = accountService.list();
  const snapshots = getAllLatestSnapshots();
  const snapshotMap = new Map(snapshots.map(s => [s.account_id, s]));
  const nowS = Math.floor(Date.now() / 1000);
  const result: AccountUsageEntry[] = [];
  for (const acc of accounts) {
    const withTokens = accountService.getWithTokens(acc.id);
    const isOAuth = withTokens?.accessToken.startsWith("sk-ant-oat") ?? false;
    const row = snapshotMap.get(acc.id);
    result.push({
      accountId: acc.id,
      accountLabel: acc.label,
      accountStatus: acc.status,
      isOAuth,
      usage: row ? snapshotToUsage(row) : {},
    });
  }
  return result;
}

/** Get cached usage for active account (used by chat header) */
export function getCachedUsage(): ClaudeUsage & { activeAccountId?: string; activeAccountLabel?: string } {
  const activeId = accountSelector.lastPickedId;
  if (activeId) {
    const usage = getUsageForAccount(activeId);
    const acc = accountService.list().find(a => a.id === activeId);
    return {
      ...usage,
      totalCostUsd: inMemoryCostUsd > 0 ? inMemoryCostUsd : undefined,
      activeAccountId: activeId,
      activeAccountLabel: acc?.label ?? undefined,
    };
  }
  // Legacy fallback
  const row = getLatestLimitSnapshot();
  const result: ClaudeUsage = {};
  if (inMemoryCostUsd > 0) result.totalCostUsd = inMemoryCostUsd;
  if (!row) return result;
  return snapshotToUsage(row);
}

export function startUsagePolling(): void {
  if (hotState.pollTimer) return;
  const POLL_TIMEOUT = 60_000; // max 60s per poll iteration
  const scheduleNext = () => {
    hotState.pollTimer = setTimeout(async () => {
      const timeout = new Promise<"timeout">(r => setTimeout(() => r("timeout"), POLL_TIMEOUT));
      const result = await Promise.race([
        pollOnce().then(() => "done" as const),
        timeout,
      ]).catch(() => "error" as const);
      // If the poll timed out, force-clear inflightPoll so next scheduled poll
      // starts a fresh fetch instead of reusing the stale hanging promise.
      if (result === "timeout") hotState.inflightPoll = null;
      scheduleNext();
    }, POLL_INTERVAL);
  };
  pollOnce().then(scheduleNext, scheduleNext);
}

export function stopUsagePolling(): void {
  if (hotState.pollTimer) { clearTimeout(hotState.pollTimer); hotState.pollTimer = null; }
}

export function updateFromSdkEvent(_rateLimitType?: string, _utilization?: number, costUsd?: number): void {
  if (costUsd != null) inMemoryCostUsd += costUsd;
}

export async function refreshUsageNow(): Promise<ClaudeUsage & { activeAccountId?: string; activeAccountLabel?: string }> {
  await pollOnce();
  return getCachedUsage();
}

/** @internal Test-only: reset module-level state between tests */
export function _resetForTesting(): void {
  inMemoryCostUsd = 0;
  if (hotState.pollTimer) { clearTimeout(hotState.pollTimer); hotState.pollTimer = null; }
  tokenCooldowns.clear();
  hotState.inflightPoll = null;
  tokenCache = null;
}
