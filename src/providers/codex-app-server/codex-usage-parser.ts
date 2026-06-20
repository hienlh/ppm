import type { UsageInfo, LimitBucket } from "../provider.interface.ts";
import type { GetAccountRateLimitsResponse, RateLimitWindow } from "./codex-protocol.ts";

/** codex resetsAt is a unix timestamp; tolerate seconds or milliseconds. */
function toIso(resetsAt: number | null | undefined): string | undefined {
  if (resetsAt == null) return undefined;
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function toBucket(w: RateLimitWindow | null | undefined): LimitBucket | undefined {
  if (!w) return undefined;
  const windowHours = w.windowDurationMins != null ? w.windowDurationMins / 60 : 0;
  const resetsAt = toIso(w.resetsAt);
  let resetsInMinutes: number | null = null;
  if (w.resetsAt != null) {
    const ms = (w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt) - Date.now();
    resetsInMinutes = Math.max(0, Math.round(ms / 60000));
  }
  return {
    utilization: (w.usedPercent ?? 0) / 100,
    resetsAt: resetsAt ?? "",
    resetsInMinutes,
    resetsInHours: resetsInMinutes != null ? Math.round((resetsInMinutes / 60) * 10) / 10 : null,
    windowHours,
  };
}

/**
 * Map codex `account/rateLimits/read` → PPM UsageInfo. `primary` window ≈ short
 * (5h-like) bucket, `secondary` ≈ long (weekly-like) bucket. Empty/missing → {}.
 */
export function parseCodexUsage(res: GetAccountRateLimitsResponse | null | undefined): UsageInfo {
  const snap = res?.rateLimits;
  if (!snap) return {};
  const primary = snap.primary ?? null;
  const secondary = snap.secondary ?? null;
  const out: UsageInfo = {};
  if (primary?.usedPercent != null) {
    out.fiveHour = primary.usedPercent / 100;
    out.fiveHourResetsAt = toIso(primary.resetsAt);
    out.session = toBucket(primary);
  }
  if (secondary?.usedPercent != null) {
    out.sevenDay = secondary.usedPercent / 100;
    out.sevenDayResetsAt = toIso(secondary.resetsAt);
    out.weekly = toBucket(secondary);
  }
  if (snap.planType) out.activeAccountLabel = String(snap.planType);
  return out;
}
