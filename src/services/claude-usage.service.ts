import { homedir } from "node:os";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  getLatestLimitSnapshot,
  getLatestSnapshotForAccount,
  getAllLatestSnapshots,
  type LimitSnapshotRow,
} from "./db.service.ts";
import { accountService, isMissingScopeResponse } from "./account.service.ts";
import { decrypt } from "../lib/account-crypto.ts";
import { accountSelector } from "./account-selector.service.ts";
import { registerAllUsageSources } from "./provider-usage/register-usage-sources.ts";
import { startProviderUsagePolling, stopProviderUsagePolling, sweepUsageSource } from "./provider-usage/usage-scheduler.ts";
import { refreshUsage as refreshProviderUsage } from "./provider-usage/usage-registry.ts";
import { claudeUsageSource } from "./claude-usage-source.ts";
import { resetUsageRuntimeState } from "./provider-usage/index.ts";
import { deserializeUsageExtra, parseClaudeScopedLimits, scopedBucket } from "../shared/usage-extra.ts";
import { parseClaudeLimitResets } from "../shared/claude-limit-resets.ts";
import { claudeCliHeaders } from "./claude-cli-identity.ts";
import type { ClaudeLimitResets, ScopedLimitBucket } from "../types/chat.ts";

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
  /** Per-model weekly limits ("Fable", …) — see `shared/usage-extra.ts`. */
  weeklyScoped?: ScopedLimitBucket[];
  /** Free limit resets the account holds — see `shared/claude-limit-resets.ts`. */
  limitResets?: ClaudeLimitResets;
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
/**
 * The usage read with the account's free limit resets in it, as Claude Code asks for it. Sent
 * as Claude Code (`claude-cli-identity.ts`): to anything else Anthropic lists no grant.
 */
const USAGE_WITH_RESETS_URL = `${API_URL}?cedar_ember=1&skip_spend=1`;
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
/**
 * The cheapest model there is. Reading usage from response headers is a real request billed to
 * the account (about ten input tokens and one output token), so it goes to the smallest model.
 */
const HEADER_PROBE_MODEL = "claude-haiku-4-5";
const API_BETA = "oauth-2025-04-20";
const USER_AGENT = "claude-code/1.0";
const FETCH_TIMEOUT = 10_000;
let inMemoryCostUsd = 0;

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
  const { weeklyScoped, limitResets } = deserializeUsageExtra(row.extra_json);
  if (weeklyScoped) result.weeklyScoped = weeklyScoped;
  if (limitResets) result.limitResets = limitResets;
  return result;
}

// ---------------------------------------------------------------------------
// Fetch usage for a single token
// ---------------------------------------------------------------------------

/** Back off a token after a 429, and say for how long. */
function coolDown(token: string, res: Response, what: string): Error {
  const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10);
  const cooldownMs = Math.max(retryAfter * 1000, MIN_COOLDOWN_MS);
  tokenCooldowns.set(token.substring(0, 20), Date.now() + cooldownMs);
  return new Error(`${what} 429 — cooldown ${Math.ceil(cooldownMs / 1000)}s`);
}

/** One `anthropic-ratelimit-unified-<window>-*` header pair as a bucket; utilization arrives as 0–1. */
function headerBucket(headers: Headers, window: string, windowHours: number): LimitBucket | undefined {
  const util = Number(headers.get(`anthropic-ratelimit-unified-${window}-utilization`) ?? NaN);
  if (!Number.isFinite(util)) return undefined;
  const resetS = Number(headers.get(`anthropic-ratelimit-unified-${window}-reset`) ?? 0);
  return parseApiBucket({
    utilization: util * 100,
    resets_at: resetS > 0 ? new Date(resetS * 1000).toISOString() : "",
  }, windowHours);
}

/**
 * Usage for a token that may not read the usage endpoint: one from `claude setup-token` carries
 * only `user:inference`, so `/api/oauth/usage` answers 403. Every message response carries the
 * same 5-hour and 7-day figures in its `anthropic-ratelimit-unified-*` headers (Claude Code's
 * own status line reads them there), so a one-token message reads them back. Unlike the usage
 * endpoint this spends a little of the account's limit, which is why it is the fallback only.
 */
async function fetchUsageFromRateLimitHeaders(token: string): Promise<ClaudeUsage> {
  const res = await fetch(MESSAGES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": API_BETA,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ model: HEADER_PROBE_MODEL, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  await res.text().catch(() => "");
  // A refused message still reports the windows it was refused for — that is the reading an
  // exhausted account most needs — so the headers are read whatever the status.
  const session = headerBucket(res.headers, "5h", 5);
  const weekly = headerBucket(res.headers, "7d", 168);
  if (!session && !weekly) {
    if (res.status === 429) throw coolDown(token, res, "Usage via message");
    throw new Error(`Usage via message returned ${res.status} with no rate-limit headers`);
  }
  const data: ClaudeUsage = { lastFetchedAt: new Date().toISOString() };
  if (session) data.session = session;
  if (weekly) data.weekly = weekly;
  return data;
}

async function fetchUsageForToken(token: string): Promise<ClaudeUsage> {
  const res = await fetch(USAGE_WITH_RESETS_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-beta": API_BETA,
      ...claudeCliHeaders(),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (res.status === 429) throw coolDown(token, res, "Usage API");
  if (res.status === 403 && isMissingScopeResponse(res.status, await res.text().catch(() => ""))) {
    return fetchUsageFromRateLimitHeaders(token);
  }
  if (!res.ok) throw new Error(`Usage API returned ${res.status}`);
  const raw = (await res.json()) as Record<string, any>;
  const data: ClaudeUsage = { lastFetchedAt: new Date().toISOString() };
  if (raw.five_hour) data.session = parseApiBucket(raw.five_hour, 5);
  if (raw.seven_day) data.weekly = parseApiBucket(raw.seven_day, 168);
  if (raw.seven_day_opus) data.weeklyOpus = parseApiBucket(raw.seven_day_opus, 168);
  if (raw.seven_day_sonnet) data.weeklySonnet = parseApiBucket(raw.seven_day_sonnet, 168);
  // A model with its own weekly cap (Fable) is reported only in `limits[]`. When the legacy
  // opus/sonnet key is also present for the same model, keep the legacy bar and skip the
  // duplicate rather than showing one limit twice.
  const scoped = parseClaudeScopedLimits(raw)
    .filter((s) => !(data.weeklyOpus && /^opus\b/i.test(s.label)) && !(data.weeklySonnet && /^sonnet\b/i.test(s.label)))
    .map(scopedBucket);
  if (scoped.length) data.weeklyScoped = scoped;
  const resets = parseClaudeLimitResets(raw);
  if (resets) data.limitResets = resets;
  return data;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Multi-account polling
// ---------------------------------------------------------------------------

/**
 * Whether a background sweep should pass over this account without calling it.
 *
 * Not a failure: an expired login, an API key (no usage endpoint), or a token
 * still inside its post-429 cooldown all mean "nothing to ask right now", and
 * the last stored reading stays valid.
 */
export async function shouldSkipClaudeAccount(accountId: string): Promise<boolean> {
  const acc = accountService.list().find((a) => a.id === accountId);
  if (!acc) return true;
  const nowS = Math.floor(Date.now() / 1000);
  // Disabled accounts still poll usage — disable only removes them from the chat
  // rotation, it should not stop usage tracking. (GET usage doesn't consume quota.)
  // Skip expired temporary accounts (no refresh token).
  if (!accountService.hasRefreshToken(acc.id) && acc.expiresAt && acc.expiresAt < nowS) return true;
  const withTokens = await accountService.ensureFreshToken(acc.id);
  if (!withTokens) return true;
  // Only OAuth tokens have a usage endpoint.
  if (!withTokens.accessToken.startsWith("sk-ant-oat")) return true;
  const cooldownUntil = tokenCooldowns.get(withTokens.accessToken.substring(0, 20));
  if (cooldownUntil && Date.now() < cooldownUntil) {
    console.log(`[usage] ${acc.label ?? acc.id}: rate-limited, ${Math.ceil((cooldownUntil - Date.now()) / 1000)}s remaining`);
    return true;
  }
  return false;
}

/**
 * Read one Claude account's usage live. Throws on failure — the shared layer
 * needs to tell a failure apart from an account with nothing to report.
 *
 * Persisting is deliberately NOT done here: that belongs to the shared layer,
 * which stores every provider's snapshots through one path.
 */
export async function fetchClaudeAccountUsage(accountId: string): Promise<ClaudeUsage> {
  const withTokens = await accountService.ensureFreshToken(accountId);
  if (!withTokens) throw new Error(`account ${accountId} has no usable token`);
  const token = withTokens.accessToken;
  const data = await fetchUsageForToken(token);
  tokenCooldowns.delete(token.substring(0, 20)); // cleared on success
  return data;
}

/**
 * Read the ambient Claude login (macOS Keychain or `~/.claude/.credentials.json`),
 * for installs that never added an account to PPM.
 */
export async function fetchLegacyClaudeUsage(): Promise<ClaudeUsage> {
  const token = getLegacyAccessToken();
  if (!token) throw new Error("no ambient Claude login");
  return fetchUsageForToken(token);
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

/**
 * Cached usage for the account a caller cares about (used by chat header).
 *
 * `preferredAccountId` exists because accounts are bound per session: `lastPickedId` is a
 * single global, so with two sessions on two accounts it names whichever ran last — the
 * wrong account for at least one of the tabs displaying it.
 */
export function getCachedUsage(preferredAccountId?: string): ClaudeUsage & { activeAccountId?: string; activeAccountLabel?: string } {
  const activeId = preferredAccountId ?? accountSelector.lastPickedId;
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

/**
 * Start background usage refresh for EVERY provider, not only Claude.
 *
 * Kept under its historical name because that is what `server/index.ts` calls,
 * but the timer, the stagger, the per-fetch timeout, and the persistence now
 * live in the shared provider-usage layer. Claude reaches them through
 * `claudeUsageSource` exactly as codex reaches them through its own source.
 */
export function startUsagePolling(): void {
  registerAllUsageSources();
  startProviderUsagePolling();
}

export function stopUsagePolling(): void {
  stopProviderUsagePolling();
}

export function updateFromSdkEvent(_rateLimitType?: string, _utilization?: number, costUsd?: number): void {
  if (costUsd != null) inMemoryCostUsd += costUsd;
}

export async function refreshUsageNow(): Promise<ClaudeUsage & { activeAccountId?: string; activeAccountLabel?: string }> {
  // One sweep of Claude's accounts through the shared layer — same code path the
  // background timer uses, so a manual refresh cannot drift from an automatic one.
  registerAllUsageSources();
  await sweepUsageSource(claudeUsageSource);
  return getCachedUsage();
}

/** Fetch + persist usage for a single account (used right after an account is added). */
export async function refreshUsageForAccount(accountId: string): Promise<ClaudeUsage> {
  registerAllUsageSources();
  if (await shouldSkipClaudeAccount(accountId)) return getUsageForAccount(accountId);
  // The shared layer caches, stores, and swallows the error into the last known
  // value, so there is nothing left for this wrapper to do but name the account.
  return refreshProviderUsage("claude", accountId);
}

/** @internal Test-only: reset module-level state between tests */
export function _resetForTesting(): void {
  inMemoryCostUsd = 0;
  tokenCooldowns.clear();
  tokenCache = null;
  // The timer, in-flight sweeps, and the usage cache moved to the shared layer,
  // so the reset has to reach them there or a stuck sweep survives the reset.
  resetUsageRuntimeState();
}
