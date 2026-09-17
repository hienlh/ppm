import type { LimitBucket } from "../types/chat.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_DAYS = 7;

export interface DailyGuardState {
  day: number;
  cap: number;
  used: number;
  blocked: boolean;
}

/** Split a weekly quota into seven daily envelopes. */
export function dailyGuardState(bucket: LimitBucket | undefined, now = Date.now()): DailyGuardState | null {
  if (!bucket || bucket.windowHours !== 168) return null;
  const resetsAt = new Date(bucket.resetsAt).getTime();
  if (!Number.isFinite(resetsAt) || resetsAt <= now) return null;

  const startedAt = resetsAt - WEEK_DAYS * DAY_MS;
  const day = Math.min(WEEK_DAYS, Math.max(1, Math.ceil((now - startedAt) / DAY_MS)));
  const cap = day / WEEK_DAYS;
  return { day, cap, used: bucket.utilization, blocked: bucket.utilization >= cap };
}

export function dailyGuardMessage(state: DailyGuardState): string {
  return `Daily guard reached: ${Math.round(state.used * 100)}% used; day ${state.day}/7 allows ${Math.round(state.cap * 100)}%. Turn off Daily guard on this account to continue.`;
}
