/** `ctx.state`: one JSON value per schedule, read when its process starts and written by `save`. */
import { utf8Length } from "../../shared/schedule-definition.ts";
import type { Schedule } from "../../types/scheduler.ts";
import { getDb } from "../db.service.ts";

/** Ten times the largest state a bot keeps today (pr-review, ~141 KB). */
export const STATE_MAX_BYTES = 2 * 1024 * 1024;

export function loadState(schedule: Pick<Schedule, "state_json">): unknown {
  if (!schedule.state_json) return {};
  try {
    return JSON.parse(schedule.state_json);
  } catch {
    return {};
  }
}

/** Replaces the schedule's state with `json`, or throws and leaves the one it had. */
export function saveState(scheduleId: number, json: unknown): void {
  if (typeof json !== "string") throw new Error("ctx.state must be a JSON value");
  const bytes = utf8Length(json);
  if (bytes > STATE_MAX_BYTES) {
    throw new Error(`ctx.state is ${(bytes / 1024 / 1024).toFixed(1)} MB; a schedule keeps at most 2 MB`);
  }
  try {
    JSON.parse(json);
  } catch {
    throw new Error("ctx.state is not valid JSON");
  }
  // Not updateSchedule: a state written every tick is not an edit of the schedule (updated_at).
  getDb().query("UPDATE schedules SET state_json = ? WHERE id = ?").run(json, scheduleId);
}

/** Forgets the state: the next process starts from `{}`. */
export function clearState(scheduleId: number): void {
  getDb().query("UPDATE schedules SET state_json = NULL WHERE id = ?").run(scheduleId);
}
