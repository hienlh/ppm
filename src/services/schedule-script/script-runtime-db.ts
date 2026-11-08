/** `schedule_runtime`: the child a script schedule runs in, recorded so a restarted server finds it. */
import { getDb } from "../db.service.ts";

export interface RuntimeRow {
  schedule_id: number;
  pid: number | null;
  token: string | null;
  started_at: string | null;
  restarts: number;
  last_exit_at: string | null;
  last_error: string | null;
}

export function recordSpawn(scheduleId: number, pid: number, token: string): void {
  getDb().query(
    `INSERT INTO schedule_runtime (schedule_id, pid, token, started_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(schedule_id) DO UPDATE SET pid = excluded.pid, token = excluded.token, started_at = excluded.started_at`,
  ).run(scheduleId, pid, token);
}

/** The child is gone. Only clears the row if it still names that child (a newer one may have started). */
export function recordExit(scheduleId: number, token: string): void {
  getDb().query(
    `UPDATE schedule_runtime SET pid = NULL, token = NULL, last_exit_at = datetime('now')
     WHERE schedule_id = ? AND token = ?`,
  ).run(scheduleId, token);
}

/** Why the last child ended, already masked by the caller; null when it ended cleanly. */
export function setLastError(scheduleId: number, error: string | null): void {
  getDb().query("UPDATE schedule_runtime SET last_error = ? WHERE schedule_id = ?").run(error, scheduleId);
}

export function setRestarts(scheduleId: number, restarts: number): void {
  getDb().query("UPDATE schedule_runtime SET restarts = ? WHERE schedule_id = ?").run(restarts, scheduleId);
}

export function getRuntime(scheduleId: number): RuntimeRow | null {
  return getDb().query("SELECT * FROM schedule_runtime WHERE schedule_id = ?").get(scheduleId) as RuntimeRow | null;
}

export function runtimeRowsWithChild(): RuntimeRow[] {
  return getDb().query("SELECT * FROM schedule_runtime WHERE pid IS NOT NULL").all() as RuntimeRow[];
}

export function clearRuntimeChild(scheduleId: number): void {
  getDb().query("UPDATE schedule_runtime SET pid = NULL, token = NULL WHERE schedule_id = ?").run(scheduleId);
}
