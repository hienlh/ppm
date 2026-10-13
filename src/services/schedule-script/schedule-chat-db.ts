/**
 * The rows behind `ctx.ai.chat`: which chat each key of a schedule talks to (`schedule_chats`),
 * and the turns a script started without waiting (`schedule_ai_turns`), which `ctx.ai.finished()`
 * hands out once each. Both go with their schedule (ON DELETE CASCADE); the chats themselves stay.
 */
import { getDb } from "../db.service.ts";

export interface ScheduleChat {
  session_id: string;
  /** The title the script last gave the chat, so a title the user set since is left alone. */
  title: string | null;
}

export function getScheduleChat(scheduleId: number, key: string): ScheduleChat | null {
  return getDb().query("SELECT session_id, title FROM schedule_chats WHERE schedule_id = ? AND key = ?")
    .get(scheduleId, key) as ScheduleChat | null;
}

export function bindScheduleChat(scheduleId: number, key: string, sessionId: string, title: string | null): void {
  getDb().query(
    `INSERT INTO schedule_chats (schedule_id, key, session_id, title, last_used_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(schedule_id, key) DO UPDATE SET session_id = excluded.session_id, title = excluded.title, last_used_at = excluded.last_used_at`,
  ).run(scheduleId, key, sessionId, title);
}

export function unbindScheduleChat(scheduleId: number, key: string): void {
  getDb().query("DELETE FROM schedule_chats WHERE schedule_id = ? AND key = ?").run(scheduleId, key);
}

export interface FinishedTurn {
  key: string;
  sessionId: string;
  ok: boolean;
  text: string;
  costUsd?: number;
  timedOut?: boolean;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export function startAiTurn(scheduleId: number, key: string, sessionId: string): number {
  const res = getDb().query("INSERT INTO schedule_ai_turns (schedule_id, key, session_id, status) VALUES (?, ?, ?, 'running')")
    .run(scheduleId, key, sessionId);
  return Number(res.lastInsertRowid);
}

export function finishAiTurn(id: number, out: { ok: boolean; text: string; sessionId: string; costUsd?: number; timedOut?: boolean; error?: string }): void {
  getDb().query(
    `UPDATE schedule_ai_turns SET status = ?, session_id = ?, text = ?, cost_usd = ?, error = ?, timed_out = ?, finished_at = datetime('now')
     WHERE id = ? AND status = 'running'`,
  ).run(out.ok ? "done" : "error", out.sessionId, out.text, out.costUsd ?? null, out.error ?? null, out.timedOut ? 1 : 0, id);
}

interface TurnRow {
  id: number; key: string; session_id: string; status: string; text: string | null; cost_usd: number | null;
  error: string | null; timed_out: number; started_at: string; finished_at: string | null;
}

/** The turns of `scheduleId` that ended since the last call, oldest first; each is returned once. */
export function collectFinishedTurns(scheduleId: number): FinishedTurn[] {
  const db = getDb();
  return db.transaction(() => {
    const rows = db.query(
      "SELECT * FROM schedule_ai_turns WHERE schedule_id = ? AND collected = 0 AND status != 'running' ORDER BY id",
    ).all(scheduleId) as TurnRow[];
    if (rows.length) {
      db.query(`UPDATE schedule_ai_turns SET collected = 1 WHERE id IN (${rows.map(() => "?").join(",")})`).run(...rows.map((r) => r.id));
    }
    return rows.map((r) => ({
      key: r.key,
      sessionId: r.session_id,
      ok: r.status === "done",
      text: r.text ?? "",
      ...(r.cost_usd != null && { costUsd: r.cost_usd }),
      ...(r.timed_out ? { timedOut: true } : {}),
      ...(r.error != null && { error: r.error }),
      startedAt: sqlTimeToIso(r.started_at),
      finishedAt: sqlTimeToIso(r.finished_at ?? r.started_at),
    }));
  })();
}

/**
 * Boot hygiene: a turn still `running` belonged to the server that just went away, so it ends
 * as interrupted (the script hears of it through `finished()`); turns over 30 days old go.
 */
export function cleanupAiTurns(): void {
  getDb().exec(`
    UPDATE schedule_ai_turns SET status = 'error', error = 'interrupted: PPM restarted', finished_at = datetime('now')
      WHERE status = 'running';
    DELETE FROM schedule_ai_turns WHERE started_at < datetime('now', '-30 days');
  `);
}

/** SQLite's `datetime('now')` is UTC without a zone: "2026-10-12 09:30:00". */
function sqlTimeToIso(value: string): string {
  return /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(" ", "T")}.000Z` : value;
}
