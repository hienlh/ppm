/**
 * The stored side of a session schedule's delivery: what changes when its turn starts, when that
 * turn ends, and when PPM gives up on the chat. A fire counts as run only once its turn has really
 * started, so a restart in between leaves it pending and it is sent again after the restart — a
 * rare double run is better than a reminder silently lost.
 */
import type { ChatLifecycleEvents } from "../chat-control/chat-lifecycle.ts";
import { createLogger } from "../logger.ts";
import {
  clearSessionSchedulePending, deleteSchedule, insertScheduleRun, setSessionSchedulePaused, setSessionSchedulePending, updateSchedule,
  updateScheduleRun,
} from "../scheduler-db.service.ts";
import type { Schedule } from "../../types/scheduler.ts";
import { describeTurnStop } from "../../shared/turn-stop.ts";

const log = createLogger("scheduler");

/** Longest piece of the turn's answer a run row keeps. */
const OUTPUT_KEEP = 2000;

/**
 * The schedule's turn started in `sessionId`: the run is recorded and a recurring schedule's
 * pending fire is spent. A one-shot keeps its fire pending until its turn has ended well
 * ({@link recordOneShotDelivered}): a turn that fails before the model sees the prompt (a sign-in
 * that expired, a provider that would not start) must not take the reminder with it.
 */
export function recordRunStarted(schedule: Schedule, sessionId: string, at: number): number {
  if (schedule.recurring) clearSessionSchedulePending(schedule.id);
  updateSchedule(schedule.id, { last_run_at: new Date(at).toISOString() });
  log.info(`Schedule ${schedule.id} (${schedule.name}) started a turn in session ${sessionId}`);
  return insertScheduleRun(schedule.id, sessionId, "running");
}

/**
 * A recurring schedule's turn failed before it did anything: the fire its turn spent is pending
 * again, so the retry sends it. A newer fire already pending is kept as it is; either way one
 * pending fire stands for both.
 */
export function restoreRecurringFire(schedule: Schedule, since: string): void {
  setSessionSchedulePending(schedule.id, since, schedule.next_fire_at);
}

/** A one-shot's turn ended without failing: its only fire is delivered, and it goes, runs and all. */
export function recordOneShotDelivered(schedule: Schedule, sessionId: string): void {
  deleteSchedule(schedule.id);
  log.info(`Schedule ${schedule.id} (${schedule.name}) delivered its one fire into session ${sessionId} and was removed`);
}

/**
 * The turn failed rather than ran: the provider threw, or an error (not the user, not the turn
 * limit) cut it off. A turn the user stopped, or one that ran into Max Turns, did run.
 */
export function turnFailed(end: ChatLifecycleEvents["turn_ended"]): boolean {
  if (end.cancelledBy) return false;
  if (end.outcome === "failed") return true;
  return end.outcome === "stopped" && end.stop?.subtype !== "error_max_turns";
}

/** The run's turn is over; `done` only when it ended with an answer and no stop. */
export function recordRunEnded(runId: number, end: ChatLifecycleEvents["turn_ended"]): void {
  const ok = end.outcome === "done" && !end.stop;
  const why = end.cancelledBy
    ? `stopped by ${end.cancelledBy}`
    : end.error ?? (end.stop ? describeTurnStop(end.stop).title : ok ? null : `the turn ${end.outcome}`);
  updateScheduleRun(runId, {
    status: ok ? "done" : "error",
    ended_at: new Date().toISOString(),
    output_truncated: end.finalText ? end.finalText.slice(0, OUTPUT_KEEP) : null,
    error: ok ? null : String(why ?? "the turn did not finish").slice(0, OUTPUT_KEEP),
  });
}

/**
 * Stop the schedule firing until someone turns it back on. Its pending fire is given up rather than
 * kept, so turning it back on does not send a prompt that came due long before.
 */
export function pauseSessionSchedule(schedule: Schedule, reason: string): void {
  setSessionSchedulePaused(schedule.id, reason);
  clearSessionSchedulePending(schedule.id);
  log.warn(`Schedule ${schedule.id} (${schedule.name}) paused: ${reason}`);
}
