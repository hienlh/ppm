/**
 * The urgency a task's due date implies, worked out when a list is read rather than stored: no
 * timer rewrites rows, and history stays free of "raised by date" noise. The floors only raise a
 * task's own urgency, never lower it:
 * overdue or due today → Now; due tomorrow → Today; due within 6 days → This week.
 */
import { URGENCIES, type Urgency } from "./ppm-tasks.ts";

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whole days from `fromYmd` to `toYmd` (negative when `toYmd` is earlier); null for a malformed date. */
export function daysBetween(fromYmd: string, toYmd: string): number | null {
  const a = YMD.exec(fromYmd);
  const b = YMD.exec(toYmd);
  if (!a || !b) return null;
  const ms = Date.UTC(+b[1]!, +b[2]! - 1, +b[3]!) - Date.UTC(+a[1]!, +a[2]! - 1, +a[3]!);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

/** The floor a due date sets, or null when it sets none (no date, or a week or more away). */
export function urgencyFloorForDue(dueYmd: string | null, todayYmd: string): Urgency | null {
  if (!dueYmd) return null;
  const days = daysBetween(todayYmd, dueYmd);
  if (days === null) return null;
  if (days <= 0) return "now";
  if (days === 1) return "today";
  if (days <= 6) return "week";
  return null;
}

/** The more urgent of two urgencies. */
export function moreUrgent(a: Urgency, b: Urgency): Urgency {
  return URGENCIES.indexOf(a) <= URGENCIES.indexOf(b) ? a : b;
}

/** Stored urgency raised by the due date, never lowered. */
export function effectiveUrgency(stored: Urgency, dueYmd: string | null, todayYmd: string): Urgency {
  const floor = urgencyFloorForDue(dueYmd, todayYmd);
  return floor ? moreUrgent(stored, floor) : stored;
}

/** Whether the due date raised the urgency above the stored one. */
export function urgencyRaisedBy(stored: Urgency, dueYmd: string | null, todayYmd: string): boolean {
  return effectiveUrgency(stored, dueYmd, todayYmd) !== stored;
}
