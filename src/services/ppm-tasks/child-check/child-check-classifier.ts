/**
 * The handed-off work checker's decisions, kept pure so a fake clock can replay them: which of the
 * four states a child chat is in, whether that state is worth telling the manager about now, and
 * when the task next needs looking at.
 *
 * - `waiting_card`: a card is on screen in the child — the user, not the manager, is needed.
 * - `running`: a turn runs and something new was written within the last interval.
 * - `stalled`: a turn runs and nothing new was written for a whole interval.
 * - `finished_no_report`: no turn runs, the last one ended at least five minutes ago, and the task
 *   has no result; or the chat never started (one interval after the hand-off), or it was deleted.
 *
 * Alerts back off: one when a state starts, one more after three intervals if nothing changed,
 * then silence until the state changes or progress resumes; never more than four per hand-off.
 */
import type { ChildCheckState } from "../../../shared/ppm-tasks.ts";

export const FINISHED_GRACE_MS = 5 * 60_000;
export const MAX_ALERTS_PER_HANDOFF = 4;
const REPEAT_AFTER_INTERVALS = 3;

export interface ChildObservation {
  /** PPM still has a record of the chat. */
  exists: boolean;
  card: boolean;
  running: boolean;
  /** The last progress seen (a new line), null when none since the hand-off. */
  lastProgressAt: number | null;
  /** The chat's last write to its transcript, null when it has none. */
  lastActivityAt: number | null;
  handedOffAt: number;
  now: number;
  intervalMs: number;
}

export interface ChildVerdict {
  state: ChildCheckState;
  /** When this state's episode began: alerts back off from here. */
  since: number;
  /** For the manager: why, in a few words. */
  reason: string;
}

export function classifyChildCheck(o: ChildObservation): ChildVerdict {
  const progressSince = o.lastProgressAt ?? o.handedOffAt;
  if (!o.exists) return { state: "finished_no_report", since: progressSince, reason: "session no longer exists" };
  if (o.card) return { state: "waiting_card", since: o.now, reason: "a card is waiting on screen" };
  if (o.running) {
    return o.now - progressSince >= o.intervalMs
      ? { state: "stalled", since: progressSince, reason: "no new output" }
      : { state: "running", since: progressSince, reason: "working" };
  }
  const started = o.lastActivityAt !== null && o.lastActivityAt >= o.handedOffAt;
  if (started) {
    return o.now - o.lastActivityAt! >= FINISHED_GRACE_MS
      ? { state: "finished_no_report", since: progressSince, reason: "went idle" }
      : { state: "running", since: progressSince, reason: "just finished a turn" };
  }
  return o.now - o.handedOffAt >= o.intervalMs
    ? { state: "finished_no_report", since: o.handedOffAt, reason: "never started on the task" }
    : { state: "running", since: o.handedOffAt, reason: "not started yet" };
}

export const isAlertState = (s: ChildCheckState): boolean => s === "stalled" || s === "finished_no_report";

export interface AlertMemory {
  alerts: number;
  lastAlertAt: number | null;
  lastAlertState: ChildCheckState | null;
}

/** Whether `verdict` should be told to the manager now, given what was told before. */
export function shouldAlert(verdict: ChildVerdict, memory: AlertMemory, now: number, intervalMs: number): boolean {
  if (!isAlertState(verdict.state) || memory.alerts >= MAX_ALERTS_PER_HANDOFF) return false;
  // A new episode: a state not alerted yet, or one that began after the last alert (progress
  // resumed and stopped again).
  if (memory.lastAlertState !== verdict.state || memory.lastAlertAt === null || memory.lastAlertAt < verdict.since) return true;
  const repeatAt = verdict.since + REPEAT_AFTER_INTERVALS * intervalMs;
  return memory.lastAlertAt < repeatAt && now >= repeatAt;
}

export interface CheckMemory extends AlertMemory {
  state: ChildCheckState;
  checkedAt: number;
  lastProgressAt: number | null;
}

/**
 * Whether the task needs a check now: a whole interval since the last one, or a decision falls due
 * sooner (a running child reaching an interval without progress; the repeat alert of a state).
 */
export function checkDue(memory: CheckMemory | null, handedOffAt: number, now: number, intervalMs: number): boolean {
  if (!memory) return now - handedOffAt >= intervalMs;
  if (now - memory.checkedAt >= intervalMs) return true;
  const since = memory.lastProgressAt ?? handedOffAt;
  if (memory.state === "running") return now - since >= intervalMs;
  if (isAlertState(memory.state) && memory.lastAlertState === memory.state && memory.alerts < MAX_ALERTS_PER_HANDOFF) {
    const repeatAt = since + REPEAT_AFTER_INTERVALS * intervalMs;
    return memory.lastAlertAt !== null && memory.lastAlertAt < repeatAt && now >= repeatAt;
  }
  return false;
}
