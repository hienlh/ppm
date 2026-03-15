import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

export interface LimitBucket {
  utilization: number;
  budgetPace: number;
  resetsAt: string;
  resetsInMinutes: number | null;
  resetsInHours: number | null;
  windowHours: number;
  status: string;
}

export interface ClaudeUsage {
  timestamp?: string;
  session?: LimitBucket;
  weekly?: LimitBucket;
  weeklyOpus?: LimitBucket;
  weeklySonnet?: LimitBucket;
}

/** Cache to avoid spawning ccburn too often */
let cache: { data: ClaudeUsage; timestamp: number } | null = null;
const CACHE_TTL = 30_000; // 30 seconds

/** Cached resolved path */
let ccburnBin: string | undefined;

/**
 * Resolve ccburn binary. Checks:
 * 1. node_modules/.bin/ccburn (relative to cwd — works for dev & prod)
 * 2. Sibling to compiled binary (dist/node_modules/.bin/ccburn)
 * 3. import.meta.dir based resolution
 */
function getCcburnPath(): string {
  if (ccburnBin) return ccburnBin;
  const candidates = [
    resolve(process.cwd(), "node_modules/.bin/ccburn"),
    resolve(dirname(process.argv[1] ?? ""), "../node_modules/.bin/ccburn"),
    resolve(dirname(process.argv[1] ?? ""), "node_modules/.bin/ccburn"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      ccburnBin = p;
      return p;
    }
  }
  throw new Error("ccburn not found — run: bun install");
}

/**
 * Fetch current usage/rate-limit info via ccburn (bundled dependency).
 * ccburn handles credential retrieval (Keychain on macOS, etc.)
 * and calls Anthropic's internal usage endpoint.
 */
export async function fetchClaudeUsage(): Promise<ClaudeUsage> {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
    return cache.data;
  }

  try {
    const bin = getCcburnPath();
    const raw = execFileSync(bin, ["--json"], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // Extract JSON (skip any warnings before it)
    const jsonStart = raw.indexOf("{");
    const jsonStr = jsonStart > 0 ? raw.slice(jsonStart) : raw;
    if (!jsonStr) return cache?.data ?? {};

    const json = JSON.parse(jsonStr) as Record<string, unknown>;
    const limits = json.limits as Record<string, unknown> | undefined;
    if (!limits) return cache?.data ?? {};

    const data: ClaudeUsage = {
      timestamp: json.timestamp as string | undefined,
    };

    if (limits.session && typeof limits.session === "object") {
      data.session = parseBucket(limits.session as Record<string, unknown>);
    }
    if (limits.weekly && typeof limits.weekly === "object") {
      data.weekly = parseBucket(limits.weekly as Record<string, unknown>);
    }
    if (limits.weekly_opus && typeof limits.weekly_opus === "object") {
      data.weeklyOpus = parseBucket(limits.weekly_opus as Record<string, unknown>);
    }
    if (limits.weekly_sonnet && typeof limits.weekly_sonnet === "object") {
      data.weeklySonnet = parseBucket(limits.weekly_sonnet as Record<string, unknown>);
    }

    cache = { data, timestamp: Date.now() };
    return data;
  } catch {
    return cache?.data ?? {};
  }
}

function parseBucket(raw: Record<string, unknown>): LimitBucket {
  return {
    utilization: (raw.utilization as number) ?? 0,
    budgetPace: (raw.budget_pace as number) ?? 0,
    resetsAt: (raw.resets_at as string) ?? "",
    resetsInMinutes: (raw.resets_in_minutes as number) ?? null,
    resetsInHours: (raw.resets_in_hours as number) ?? null,
    windowHours: (raw.window_hours as number) ?? 0,
    status: (raw.status as string) ?? "",
  };
}
