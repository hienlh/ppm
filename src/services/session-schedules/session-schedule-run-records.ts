/**
 * The stored side of a session schedule's delivery: what changes when its turn starts, when that
 * turn ends, and when PPM gives up on the chat. A fire counts as run only once its turn has really
 * started, so a restart in between leaves it pending and it is sent again after the restart — a
 * rare double run is better than a reminder silently lost.
 */
import type { ChatLifecycleEvents } from "../chat-control/chat-lifecycle.ts";
import { createLogger } from "../logger.ts";
import {
  clearSessionSchedulePending, deleteSchedule, insertScheduleRun, setSessionSchedulePaused, updateSchedule, updateScheduleRun,
} from "../scheduler-db.service.ts";
import type { Schedule } from "../../types/scheduler.ts";
import { describeTurnStop } from "../../shared/turn-stop.ts";

const log = createLogger("scheduler");

/** Longest piece of the turn's answer a run row keeps. */
const OUTPUT_KEEP = 2000;

/**
 * The schedule's turn started in `sessionId`: its pending fire is spent and the run is recorded. A
 * one-shot is deleted instead, its only fire delivered; its run row would go with it. Returns the
 * run row's id, or null when none was kept.
 */
export function recordRunStarted(schedule: Schedule, sessionId: string, at: number): number | null {
  if (!schedule.recurring) {
    deleteSchedule(schedule.id);
    log.info(`Schedule ${schedule.id} (${schedule.name}) delivered its one fire into session ${sessionId} and was removed`);
    return null;
  }
  clearSessionSchedulePending(schedule.id);
  updateSchedule(schedule.id, { last_run_at: new Date(at).toISOString() });
  log.info(`Schedule ${schedule.id} (${schedule.name}) started a turn in session ${sessionId}`);
  return insertScheduleRun(schedule.id, sessionId, "running");
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
