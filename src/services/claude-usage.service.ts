import { homedir } from "node:os";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  insertLimitSnapshot,
  getLatestLimitSnapshot,
  cleanupOldLimitSnapshots,
  type LimitSnapshotRow,
} from "./db.service.ts";

export interface LimitBucket {
  utilization: number;
  resetsAt: string;
  resetsInMinutes: number | null;
  resetsInHours: number | null;
  windowHours: number;
}

export interface ClaudeUsage {
  /** ISO timestamp of last successful fetch */
  lastFetchedAt?: string;
  session?: LimitBucket;
  weekly?: LimitBucket;
  weeklyOpus?: LimitBucket;
  weeklySonnet?: LimitBucket;
  /** Cumulative cost from SDK result events */
  totalCostUsd?: number;
}

const API_URL = "https://api.anthropic.com/api/oauth/usage";
const API_BETA = "oauth-2025-04-20";
const USER_AGENT = "claude-code/1.0";
const FETCH_TIMEOUT = 10_000; // 10s
const POLL_INTERVAL = 300_000; // auto-fetch every 5min
const RETRY_DELAY = 5_000; // 5s between retries
const MAX_RETRIES = 3;

/** In-memory accumulator for cost from SDK result events */
let inMemoryCostUsd = 0;

/** Cached OAuth token (read once from Keychain/file) */
let tokenCache: { token: string; timestamp: number } | null = null;
const TOKEN_TTL = 300_000; // re-read token every 5min

/** Auto-poll timer */
let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Read OAuth access token from macOS Keychain, fallback to credentials file.
 */
function getAccessToken(): string {
  if (tokenCache && Date.now() - tokenCache.timestamp < TOKEN_TTL) {
    return tokenCache.token;
  }

  let creds: Record<string, any> | null = null;

  // macOS Keychain
  if (process.platform === "darwin") {
    try {
      const proc = Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]);
      if (proc.exitCode === 0) {
        creds = JSON.parse(proc.stdout.toString().trim());
      }
    } catch { /* fallback to file */ }
  }

  // Fallback: ~/.claude/.credentials.json
  if (!creds) {
    const credPath = resolve(homedir(), ".claude", ".credentials.json");
    if (existsSync(credPath)) {
      creds = JSON.parse(readFileSync(credPath, "utf-8"));
    }
  }

  const token = creds?.claudeAiOauth?.accessToken;
  if (!token) throw new Error("No Claude OAuth token found");

  tokenCache = { token, timestamp: Date.now() };
  return token;
}

/** Fetch usage from Anthropic OAuth API */
async function fetchUsageFromApi(): Promise<ClaudeUsage> {
  const token = getAccessToken();
  const res = await fetch(API_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-beta": API_BETA,
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!res.ok) {
    throw new Error(`Usage API returned ${res.status}`);
  }

  const raw = (await res.json()) as Record<string, any>;
  const data: ClaudeUsage = { lastFetchedAt: new Date().toISOString() };

  if (raw.five_hour) data.session = parseApiBucket(raw.five_hour, 5);
  if (raw.seven_day) data.weekly = parseApiBucket(raw.seven_day, 168);
  if (raw.seven_day_opus) data.weeklyOpus = parseApiBucket(raw.seven_day_opus, 168);
  if (raw.seven_day_sonnet) data.weeklySonnet = parseApiBucket(raw.seven_day_sonnet, 168);

  return data;
}

/** Parse an API bucket (utilization is 0-100 from API, normalize to 0-1) */
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

/** Convert DB snapshot row fields back to a LimitBucket (recomputes time-relative fields) */
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

/** Return ClaudeUsage from the latest DB snapshot + in-memory cost */
export function getCachedUsage(): ClaudeUsage {
  const row = getLatestLimitSnapshot();
  const result: ClaudeUsage = {};
  if (inMemoryCostUsd > 0) result.totalCostUsd = inMemoryCostUsd;
  if (!row) return result;
  result.lastFetchedAt = row.recorded_at;
  if (row.five_hour_util != null) result.session = dbBucketToLimitBucket(row.five_hour_util, row.five_hour_resets_at ?? "", 5);
  if (row.weekly_util != null) result.weekly = dbBucketToLimitBucket(row.weekly_util, row.weekly_resets_at ?? "", 168);
  if (row.weekly_opus_util != null) result.weeklyOpus = dbBucketToLimitBucket(row.weekly_opus_util, row.weekly_opus_resets_at ?? "", 168);
  if (row.weekly_sonnet_util != null) result.weeklySonnet = dbBucketToLimitBucket(row.weekly_sonnet_util, row.weekly_sonnet_resets_at ?? "", 168);
  return result;
}

/** Check if new API data differs from the last DB snapshot enough to warrant a new row */
function hasChanged(data: ClaudeUsage, last: LimitSnapshotRow | null): boolean {
  if (!last) return true;
  const diff = (a: number | null | undefined, b: number | null) =>
    a != null && (b == null || Math.abs(a - b) > 0.001);
  if (diff(data.session?.utilization, last.five_hour_util)) return true;
  if (diff(data.weekly?.utilization, last.weekly_util)) return true;
  // Detect window reset (resetsAt changed)
  if (data.session?.resetsAt && data.session.resetsAt !== (last.five_hour_resets_at ?? "")) return true;
  if (data.weekly?.resetsAt && data.weekly.resetsAt !== (last.weekly_resets_at ?? "")) return true;
  return false;
}

/** Persist API data to DB if changed, then cleanup old rows */
function persistIfChanged(data: ClaudeUsage): void {
  const last = getLatestLimitSnapshot();
  if (!hasChanged(data, last)) return;
  insertLimitSnapshot({
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

/** Fetch with retry logic, persist to DB if changed */
async function fetchWithRetry(): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await fetchUsageFromApi();
      persistIfChanged(data);
      return;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // Don't retry on 429 — just use stale cache
      if (msg.includes("429")) return;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY));
      }
    }
  }
}

/** Start background auto-polling (called once on server start) */
export function startUsagePolling(): void {
  if (pollTimer) return;
  // Initial fetch
  fetchWithRetry();
  // Poll every POLL_INTERVAL
  pollTimer = setInterval(() => fetchWithRetry(), POLL_INTERVAL);
}

/** Stop background polling */
export function stopUsagePolling(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/**
 * Merge SDK result cost events into in-memory accumulator.
 * Rate limit utilization from SDK events is ignored — API polling is authoritative.
 */
export function updateFromSdkEvent(
  _rateLimitType?: string,
  _utilization?: number,
  costUsd?: number,
): void {
  if (costUsd != null) {
    inMemoryCostUsd += costUsd;
  }
}

/** Force immediate refresh from Anthropic API, persist to DB, return latest */
export async function refreshUsageNow(): Promise<ClaudeUsage> {
  await fetchWithRetry();
  return getCachedUsage();
}
