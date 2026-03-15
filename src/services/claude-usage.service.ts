import { homedir } from "node:os";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export interface LimitBucket {
  utilization: number;
  resetsAt: string;
  resetsInMinutes: number | null;
  resetsInHours: number | null;
  windowHours: number;
}

export interface ClaudeUsage {
  timestamp?: string;
  session?: LimitBucket;
  weekly?: LimitBucket;
  weeklyOpus?: LimitBucket;
  weeklySonnet?: LimitBucket;
}

const API_URL = "https://api.anthropic.com/api/oauth/usage";
const API_BETA = "oauth-2025-04-20";
const USER_AGENT = "claude-code/1.0";
const CACHE_TTL = 30_000; // 30s
const FETCH_TIMEOUT = 10_000; // 10s

/** Cached data + timestamp */
let cache: { data: ClaudeUsage; timestamp: number } | null = null;

/** Cached OAuth token (read once from Keychain/file) */
let tokenCache: { token: string; timestamp: number } | null = null;
const TOKEN_TTL = 300_000; // re-read token every 5min

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

/**
 * Fetch usage from Anthropic OAuth API — native async, zero process spawn.
 */
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
  const now = new Date().toISOString();
  const data: ClaudeUsage = { timestamp: now };

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

/**
 * Get cached usage or fetch fresh data.
 * Fully async, never blocks event loop — just a native fetch().
 */
export async function waitForFreshUsage(): Promise<ClaudeUsage> {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
    return cache.data;
  }

  try {
    const data = await fetchUsageFromApi();
    cache = { data, timestamp: Date.now() };
    return data;
  } catch {
    return cache?.data ?? {};
  }
}
