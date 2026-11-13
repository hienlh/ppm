import type { LimitBucket, UsageInfo } from "../../types/chat";

/**
 * PPM reads Antigravity's quota every 5 minutes, from the app's language server or else from
 * `agy -p /usage`. A reading older than two missed sweeps means neither answered, and the bars
 * are showing whatever was read last.
 */
export const STALE_ANTIGRAVITY_USAGE_MS = 11 * 60_000;

export function isAntigravityUsageStale(lastFetchedAt: string | undefined, now = Date.now()): boolean {
  if (!lastFetchedAt) return false;
  const at = Date.parse(lastFetchedAt);
  return Number.isFinite(at) && now - at > STALE_ANTIGRAVITY_USAGE_MS;
}

/**
 * A bucket as it stands now rather than when it was read. A window whose reset time has passed
 * has started over, so the old percentage no longer applies. An unused window has not started,
 * and the reset time the server gives for it is just "now + the window", so it is dropped, as
 * the Antigravity app does.
 */
function currentBucket<T extends LimitBucket>(bucket: T, now: number): T {
  const resetAt = bucket.resetsAt ? Date.parse(bucket.resetsAt) : Number.NaN;
  const restarted = Number.isFinite(resetAt) && resetAt <= now;
  if (!restarted && bucket.utilization > 0) return bucket;
  return { ...bucket, utilization: restarted ? 0 : bucket.utilization, resetsAt: "", resetsInMinutes: null, resetsInHours: null };
}

/** `usage` with every bucket brought up to `now`, flat mirror fields included. */
export function currentAntigravityUsage(usage: UsageInfo, now = Date.now()): UsageInfo {
  const out: UsageInfo = { ...usage };
  if (usage.session) {
    out.session = currentBucket(usage.session, now);
    out.fiveHour = out.session.utilization;
  }
  if (usage.weekly) {
    out.weekly = currentBucket(usage.weekly, now);
    out.sevenDay = out.weekly.utilization;
  }
  if (usage.weeklyScoped) out.weeklyScoped = usage.weeklyScoped.map((b) => currentBucket(b, now));
  return out;
}
