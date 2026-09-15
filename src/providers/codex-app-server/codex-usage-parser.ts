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

/** A window at least this long is a plan's long bucket rather than its short one. */
const LONG_WINDOW_MINS = 24 * 60;

/**
 * Map codex `account/rateLimits/read` → PPM UsageInfo.
 *
 * `primary` and `secondary` are positions, not meanings, and each window states its own
 * length in `windowDurationMins` — so that is what decides which bucket it belongs to. A
 * Plus plan sends a 300-minute window followed by a 10080-minute one, which is the layout
 * the old positional reading assumed. A ChatGPT Business plan sends the 10080-minute weekly
 * window **alone, in the primary slot**, and reading position as meaning labelled that
 * account's weekly quota "5-Hour" — complete with a reset nearly seven days out — while
 * leaving its actual Weekly row empty.
 *
 * Empty/missing → `{}`, which the UI reads as "the quota could not be read" and is a
 * different thing from a plan that genuinely has only one window.
 */
export function parseCodexUsage(res: GetAccountRateLimitsResponse | null | undefined): UsageInfo {
  const snap = res?.rateLimits;
  if (!snap) return {};
  const out: UsageInfo = {};
  const windows = [snap.primary ?? null, snap.secondary ?? null];
  windows.forEach((w, slot) => {
    if (w?.usedPercent == null) return;
    // A window with no declared duration leaves nothing to read, so the slot it arrived in
    // is the best guess remaining: primary is the short one wherever both are present.
    const isLong = w.windowDurationMins != null ? w.windowDurationMins >= LONG_WINDOW_MINS : slot === 1;
    if (isLong) {
      out.sevenDay = w.usedPercent / 100;
      out.sevenDayResetsAt = toIso(w.resetsAt);
      out.weekly = toBucket(w);
    } else {
      out.fiveHour = w.usedPercent / 100;
      out.fiveHourResetsAt = toIso(w.resetsAt);
      out.session = toBucket(w);
    }
  });
  if (snap.planType) out.activeAccountLabel = String(snap.planType);
  return out;
}
