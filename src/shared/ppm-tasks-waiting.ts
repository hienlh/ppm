/**
 * What a waiting task says about its wait: on whom ("Waiting on you", "Waiting on Việt", or only
 * "Waiting" when nobody is named) and until when (its due date, else how long it has waited). One
 * set of rules for the sidebar, the Tasks chip, Telegram `/tasks` and the morning digest, so the
 * four never word the same task differently.
 *
 * How long a task has waited counts from when its status moved into a Waiting-group status, read
 * from the task's history (`waitingStartedAtFromHistory`); a task with no such entry falls back
 * to when someone was named in "waiting on" (`waitingSince`).
 */
import { ME_MEMBER_ID, type BaseGroup } from "./ppm-tasks.ts";
import { daysBetween } from "./ppm-tasks-urgency.ts";

/** The task fields the wait is read from. */
export interface WaitingFacts {
  baseGroup: BaseGroup;
  waitingOnMemberId: string | null;
  waitingSince: number | null;
  /** When the status moved into the Waiting group (from history); absent from an older server. */
  waitingStartedAt?: number | null;
  dueDate: string | null;
}

export type WaitingUntil =
  | { kind: "due"; dueDate: string }
  | { kind: "for"; since: number };

export interface WaitingDetail {
  /** "Waiting on you", "Waiting on Việt", "Waiting". */
  label: string;
  /** The person waited on as the label names them ("you", "Việt"); null when nobody is named. */
  name: string | null;
  /** The wait is on the user. */
  mine: boolean;
  /** The due date when there is one, else since when; null when neither is known. */
  until: WaitingUntil | null;
}

/** An open task that waits: in a Waiting-group status, or with someone named in "waiting on". */
export function isWaitingTask(t: Pick<WaitingFacts, "baseGroup" | "waitingOnMemberId">): boolean {
  if (t.baseGroup === "closed") return false;
  return t.baseGroup === "waiting" || !!t.waitingOnMemberId;
}

/** An open waiting task whose wait is on the user. */
export function isWaitingOnMe(t: Pick<WaitingFacts, "baseGroup" | "waitingOnMemberId">): boolean {
  return isWaitingTask(t) && t.waitingOnMemberId === ME_MEMBER_ID;
}

/** Since when the task has waited: its move into the Waiting group, else when someone was named. */
export function waitedSince(t: Pick<WaitingFacts, "baseGroup" | "waitingSince" | "waitingStartedAt">): number | null {
  if (t.baseGroup === "waiting" && t.waitingStartedAt) return t.waitingStartedAt;
  return t.waitingSince ?? t.waitingStartedAt ?? null;
}

/**
 * The wait of a task, or null when it does not wait. `nameOf` answers a member's name for an id
 * other than the user's; an unknown id is shown as it is rather than dropped.
 */
export function waitingDetail(t: WaitingFacts, nameOf: (memberId: string) => string | null | undefined): WaitingDetail | null {
  if (!isWaitingTask(t)) return null;
  const id = t.waitingOnMemberId;
  const mine = id === ME_MEMBER_ID;
  const name = !id ? null : mine ? "you" : (nameOf(id)?.trim() || id);
  const since = waitedSince(t);
  const until: WaitingUntil | null = t.dueDate ? { kind: "due", dueDate: t.dueDate } : since ? { kind: "for", since } : null;
  return { label: name ? `Waiting on ${name}` : "Waiting", name, mine, until };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "now", "5m", "3h", "2d", "3w". */
export function ageShort(since: number, now: number = Date.now()): string {
  const d = Math.max(0, now - since);
  if (d < MIN) return "now";
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  if (d < 14 * DAY) return `${Math.floor(d / DAY)}d`;
  return `${Math.floor(d / (7 * DAY))}w`;
}

/** "Overdue (2026-11-14)", "Due today", "Due tomorrow", "Due in 3 days", "Due 2026-12-01". */
export function dueText(dueDate: string, today: string): string {
  const days = daysBetween(today, dueDate);
  if (days === null) return `Due ${dueDate}`;
  if (days < 0) return `Overdue (${dueDate})`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days < 7) return `Due in ${days} days`;
  return `Due ${dueDate}`;
}

/** "2 days", "1 day", "5 hours", "1 hour" (at least one hour). */
export function waitedFor(since: number, now: number): string {
  const days = Math.floor((now - since) / DAY);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.max(1, Math.floor((now - since) / HOUR));
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** The "until when" of a wait in words, for text channels: "Due today", "for 2 days". */
export function waitingUntilText(until: WaitingUntil | null, today: string, now: number): string | null {
  if (!until) return null;
  return until.kind === "due" ? dueText(until.dueDate, today) : `for ${waitedFor(until.since, now)}`;
}

/** One history entry, as far as the waiting start needs it. */
export interface StatusHistoryEntry {
  /** The row id: what orders two entries written in the same millisecond. */
  id?: number;
  at: number;
  changes: ReadonlyArray<{ field: string; before: unknown; after: unknown }>;
}

/**
 * When the task's current stay in the Waiting group began, from its history entries (any order):
 * the oldest status move of the latest unbroken run of moves into or within the group. A task
 * created in a Waiting status counts from its creation. Null when the history holds no such move
 * (a task moved before history was kept, or history compacted away). A move *out of* a status
 * `groupOf` cannot place (deleted, its group no longer on record) is not read as arriving from
 * another group, since deleting a Waiting status hands its tasks to another and that is no new
 * wait; the run cannot be followed further back through it, so it starts at that hand-over.
 */
export function waitingStartedAtFromHistory(entries: readonly StatusHistoryEntry[], groupOf: (statusId: string) => BaseGroup | undefined): number | null {
  const moves = entries
    .flatMap((e) => {
      const c = e.changes.find((x) => x.field === "statusId");
      return c && typeof c.after === "string" ? [{ id: e.id ?? 0, at: e.at, before: typeof c.before === "string" ? c.before : null, after: c.after }] : [];
    })
    .sort((a, b) => b.at - a.at || b.id - a.id);
  let start: number | null = null;
  for (const m of moves) {
    if (groupOf(m.after) !== "waiting") break;
    start = m.at;
    if (!m.before) break;
    const before = groupOf(m.before);
    if (before !== undefined && before !== "waiting") break;
  }
  return start;
}
