import type { LimitBucket } from "../types/chat.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_DAYS = 7;
const WORK_DAYS = 5;

export interface DailyGuardState {
  day: number;
  cap: number;
  used: number;
  blocked: boolean;
}

/** Five weekday envelopes, using reset-anchored 24h slots and UTC weekdays on every client. */
export function dailyGuardState(bucket: LimitBucket | undefined, now = Date.now()): DailyGuardState | null {
  if (!bucket || bucket.windowHours !== 168) return null;
  const resetsAt = new Date(bucket.resetsAt).getTime();
  if (!Number.isFinite(now) || !Number.isFinite(resetsAt) || resetsAt <= now) return null;

  const startedAt = resetsAt - WEEK_DAYS * DAY_MS;
  if (now < startedAt) return null;
  const elapsedSlot = Math.min(WEEK_DAYS - 1, Math.floor((now - startedAt) / DAY_MS));
  let day = 0;
  for (let slot = 0; slot <= elapsedSlot; slot++) {
    const weekday = new Date(startedAt + slot * DAY_MS).getUTCDay();
    if (weekday !== 0 && weekday !== 6) day++;
  }
  const cap = day / WORK_DAYS;
  return { day, cap, used: bucket.utilization, blocked: bucket.utilization >= cap };
}

export function dailyGuardMessage(state: DailyGuardState): string {
  return `Daily guard reached: ${Math.round(state.used * 100)}% used; weekday ${state.day}/5 allows ${Math.round(state.cap * 100)}%. The cap increases on weekdays only. Turn off Daily guard on this account to continue.`;
}
