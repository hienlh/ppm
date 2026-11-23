/** DB helpers for scheduled agents (`schedules` + `schedule_runs` tables). */
import { getDb } from "./db.service.ts";
import type { Schedule, ScheduleLastRun, ScheduleRun, NewSchedule, RunStatus } from "../types/scheduler.ts";

export function getSchedules(enabledOnly = false): Schedule[] {
  const sql = enabledOnly
    ? "SELECT * FROM schedules WHERE enabled = 1 ORDER BY id"
    : "SELECT * FROM schedules ORDER BY id";
  return getDb().query(sql).all() as Schedule[];
}

export function getSchedule(id: number): Schedule | null {
  return getDb().query("SELECT * FROM schedules WHERE id = ?").get(id) as Schedule | null;
}

/**
 * Enabled schedules whose next_fire_at has passed. A paused one is left out here and below: it is
 * not advanced while paused, so counting it would wake the timer at once, over and over.
 */
export function getDueSchedules(nowIso: string): Schedule[] {
  return getDb().query(
    "SELECT * FROM schedules WHERE enabled = 1 AND paused_reason IS NULL AND next_fire_at IS NOT NULL AND next_fire_at <= ?",
  ).all(nowIso) as Schedule[];
}

/** When the earliest enabled schedule is due, or null when none is waiting on a cron. */
export function getEarliestFireAt(): string | null {
  const row = getDb().query(
    "SELECT MIN(next_fire_at) AS at FROM schedules WHERE enabled = 1 AND paused_reason IS NULL AND next_fire_at IS NOT NULL",
  ).get() as { at: string | null } | null;
  return row?.at ?? null;
}

export function insertSchedule(s: NewSchedule): number {
  const res = getDb().query(
    `INSERT INTO schedules (name, cron_expr, provider_id, project_path, prompt, permission_mode, max_turns, timeout_ms, enabled, next_fire_at,
       kind, mode, description, script, inputs_json, input_values_json, secrets_enc, target_session_id, timezone, recurring, task_id, created_by_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.name, s.cron_expr, s.provider_id, s.project_path, s.prompt,
    s.permission_mode ?? "bypassPermissions",
    s.max_turns ?? null,
    s.timeout_ms ?? 1_800_000,
    s.enabled === false ? 0 : 1,
    s.next_fire_at ?? null,
    s.kind ?? "prompt",
    s.mode ?? "tick",
    s.description ?? "",
    s.script ?? null,
    s.inputs_json ?? "[]",
    s.input_values_json ?? "{}",
    s.secrets_enc ?? null,
    s.target_session_id ?? null,
    s.timezone ?? null,
    s.recurring === false ? 0 : 1,
    s.task_id ?? null,
    s.created_by_session_id ?? null,
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

/**
 * A run recorded once it is over — a script tick, which keeps a row only when it has something
 * to show. `started_at` in SQLite's own format, as the column's default writes it.
 */
export function insertFinishedRun(scheduleId: number, run: {
  status: Extract<RunStatus, "done" | "error">; startedAt: number; output: string; error: string | null; costUsd?: number;
}): number {
  const res = getDb().query(
    `INSERT INTO schedule_runs (schedule_id, status, output_truncated, error, cost_usd, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    scheduleId, run.status, run.output || null, run.error, run.costUsd ?? null,
    new Date(run.startedAt).toISOString().replace("T", " ").slice(0, 19), new Date().toISOString(),
  );
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

/**
 * Boot hygiene: orphan stale running rows (>2h) and prune runs older than 30 days. A script's
 * running row is the life of an always-on process, hours long by design: the always-on
 * supervisor closes those itself.
 */
export function cleanupScheduleRuns(): void {
  getDb().exec(`
    UPDATE schedule_runs SET status = 'error', error = 'orphaned: server restart', ended_at = datetime('now')
      WHERE status = 'running' AND started_at < datetime('now', '-2 hours')
        AND schedule_id NOT IN (SELECT id FROM schedules WHERE kind = 'script');
    DELETE FROM schedule_runs WHERE started_at < datetime('now', '-30 days');
  `);
}

// --- Session schedules: a prompt delivered into an existing chat ---------------------------

/** The session schedules aimed at one chat, oldest first. */
export function listSessionSchedulesForTarget(sessionId: string): Schedule[] {
  return getDb().query(
    "SELECT * FROM schedules WHERE kind = 'session' AND target_session_id = ? ORDER BY id",
  ).all(sessionId) as Schedule[];
}

/** The schedules of any kind one chat's AI created, oldest first. */
export function listSchedulesCreatedBy(sessionId: string): Schedule[] {
  return getDb().query(
    "SELECT * FROM schedules WHERE created_by_session_id = ? ORDER BY id",
  ).all(sessionId) as Schedule[];
}

/** How many session schedules are aimed at one chat, on or off. */
export function countSessionSchedules(sessionId: string): number {
  return (getDb().query(
    "SELECT COUNT(*) AS n FROM schedules WHERE kind = 'session' AND target_session_id = ?",
  ).get(sessionId) as { n: number }).n;
}

/** Session schedules that can fire and have a fire waiting to be delivered. */
export function getPendingSessionSchedules(): Schedule[] {
  return getDb().query(
    "SELECT * FROM schedules WHERE kind = 'session' AND enabled = 1 AND paused_reason IS NULL AND pending_since IS NOT NULL ORDER BY pending_since, id",
  ).all() as Schedule[];
}

/**
 * Record a fire that came due at `since` and move on to `nextFireAt`. A fire already waiting keeps
 * its time: fires that pass before delivery become that one delivery, not a queue of them.
 */
export function setSessionSchedulePending(id: number, since: string, nextFireAt: string | null): void {
  getDb().query(
    "UPDATE schedules SET pending_since = COALESCE(pending_since, ?), next_fire_at = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(since, nextFireAt, id);
}

/** The waiting fire was delivered (or given up). */
export function clearSessionSchedulePending(id: number): void {
  getDb().query("UPDATE schedules SET pending_since = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
}

/** Stop a session schedule firing until someone turns it back on, saying why. */
export function setSessionSchedulePaused(id: number, reason: string): void {
  getDb().query("UPDATE schedules SET paused_reason = ?, updated_at = datetime('now') WHERE id = ?").run(reason, id);
}

/** Let a paused session schedule fire again from `nextFireAt` on. */
export function clearSessionSchedulePaused(id: number, nextFireAt: string | null): void {
  getDb().query(
    "UPDATE schedules SET paused_reason = NULL, next_fire_at = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(nextFireAt, id);
}

/** Delete every session schedule aimed at a chat that is gone; answers how many there were. */
export function deleteSessionSchedulesForTarget(sessionId: string): number {
  return getDb().query("DELETE FROM schedules WHERE kind = 'session' AND target_session_id = ?").run(sessionId).changes;
}

/** Follow a chat whose id changed (Codex renames a new chat); answers how many schedules moved. */
export function retargetSessionSchedules(oldId: string, newId: string): number {
  if (oldId === newId) return 0;
  return getDb().query(
    "UPDATE schedules SET target_session_id = ?, updated_at = datetime('now') WHERE kind = 'session' AND target_session_id = ?",
  ).run(newId, oldId).changes;
}

/**
 * Each schedule's newest run that did something, keyed by schedule id. A skipped tick (its
 * previous run still going) is not one: it would hide the run that is actually going on.
 */
export function lastRunsFor(scheduleIds: number[]): Map<number, ScheduleLastRun> {
  const result = new Map<number, ScheduleLastRun>();
  if (scheduleIds.length === 0) return result;
  // One indexed lookup per schedule (`idx_schedule_runs_sched`): the list is polled, and a
  // schedule ticking every minute keeps tens of thousands of runs that a GROUP BY would read whole.
  const newest = getDb().query(
    `SELECT id, status, started_at, ended_at, error, COALESCE(rotated_to_session_id, session_id) AS session_id
     FROM schedule_runs WHERE schedule_id = ? AND status != 'skipped' ORDER BY started_at DESC, id DESC LIMIT 1`,
  );
  for (const id of new Set(scheduleIds)) {
    const run = newest.get(id) as ScheduleLastRun | null;
    if (run) result.set(id, run);
  }
  return result;
}

/** The reminders a task owns, oldest first. */
export function listSchedulesForTask(taskId: string): Schedule[] {
  return getDb().query("SELECT * FROM schedules WHERE task_id = ? ORDER BY id").all(taskId) as Schedule[];
}

/** Delete every schedule these tasks own; answers the deleted rows. */
export function deleteSchedulesForTasks(taskIds: string[]): Schedule[] {
  if (taskIds.length === 0) return [];
  const marks = taskIds.map(() => "?").join(", ");
  return getDb().query(`DELETE FROM schedules WHERE task_id IN (${marks}) RETURNING *`).all(...taskIds) as Schedule[];
}

/** Remember which problem the user dismissed; null clears it. */
export function setAttentionDismissed(id: number, key: string | null): void {
  getDb().query("UPDATE schedules SET attention_dismissed = ? WHERE id = ?").run(key, id);
}
