/** DB helpers for scheduled agents (`schedules` + `schedule_runs` tables). */
import { getDb } from "./db.service.ts";
import type { Schedule, ScheduleRun, NewSchedule, RunStatus } from "../types/scheduler.ts";

export function getSchedules(enabledOnly = false): Schedule[] {
  const sql = enabledOnly
    ? "SELECT * FROM schedules WHERE enabled = 1 ORDER BY id"
    : "SELECT * FROM schedules ORDER BY id";
  return getDb().query(sql).all() as Schedule[];
}

export function getSchedule(id: number): Schedule | null {
  return getDb().query("SELECT * FROM schedules WHERE id = ?").get(id) as Schedule | null;
}

/** Enabled schedules whose next_fire_at has passed. */
export function getDueSchedules(nowIso: string): Schedule[] {
  return getDb().query(
    "SELECT * FROM schedules WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?",
  ).all(nowIso) as Schedule[];
}

export function insertSchedule(s: NewSchedule): number {
  const res = getDb().query(
    `INSERT INTO schedules (name, cron_expr, provider_id, project_path, prompt, permission_mode, max_turns, timeout_ms, enabled, next_fire_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.name, s.cron_expr, s.provider_id, s.project_path, s.prompt,
    s.permission_mode ?? "bypassPermissions",
    s.max_turns ?? null,
    s.timeout_ms ?? 1_800_000,
    s.enabled === false ? 0 : 1,
    s.next_fire_at ?? null,
  );
  return Number(res.lastInsertRowid);
}

export function updateSchedule(id: number, fields: Partial<Omit<Schedule, "id" | "created_at">>): void {
  const keys = Object.keys(fields) as Array<keyof typeof fields>;
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => fields[k] as string | number | null);
  getDb().query(
    `UPDATE schedules SET ${sets}, updated_at = datetime('now') WHERE id = ?`,
  ).run(...values, id);
}

export function deleteSchedule(id: number): void {
  getDb().query("DELETE FROM schedules WHERE id = ?").run(id);
}

export function setScheduleSessionId(id: number, sessionId: string): void {
  getDb().query(
    "UPDATE schedules SET session_id = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(sessionId, id);
}

export function insertScheduleRun(scheduleId: number, sessionId: string | null, status: RunStatus = "running"): number {
  const res = getDb().query(
    "INSERT INTO schedule_runs (schedule_id, session_id, status) VALUES (?, ?, ?)",
  ).run(scheduleId, sessionId, status);
  return Number(res.lastInsertRowid);
}

export function updateScheduleRun(
  runId: number,
  fields: Partial<Pick<ScheduleRun, "status" | "session_id" | "output_truncated" | "context_window_pct" | "cost_usd" | "error" | "rotated_to_session_id" | "ended_at">>,
): void {
  const keys = Object.keys(fields) as Array<keyof typeof fields>;
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => fields[k] as string | number | null);
  getDb().query(`UPDATE schedule_runs SET ${sets} WHERE id = ?`).run(...values, runId);
}

export function listScheduleRuns(scheduleId: number, limit = 20): ScheduleRun[] {
  return getDb().query(
    "SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC, id DESC LIMIT ?",
  ).all(scheduleId, limit) as ScheduleRun[];
}

/** Boot hygiene: orphan stale running rows (>2h) and prune runs older than 30 days. */
export function cleanupScheduleRuns(): void {
  getDb().exec(`
    UPDATE schedule_runs SET status = 'error', error = 'orphaned: server restart', ended_at = datetime('now')
      WHERE status = 'running' AND started_at < datetime('now', '-2 hours');
    DELETE FROM schedule_runs WHERE started_at < datetime('now', '-30 days');
  `);
}
