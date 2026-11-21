import { getDb } from "../db.service.ts";
import { createLogger } from "../logger.ts";
import {
  SETTING_CHANGES_EVENT, SETTING_CHANGES_RETENTION_DAYS, type SettingChangeApproval, type SettingChangeKind, type SettingChangeOrigin, type SettingChangeRow,
} from "../../shared/assistant-settings-changes.ts";

/**
 * The change log behind Undo: one row per setting the PPM Assistant changed, per install or removal,
 * and per undo (`undoes` names the row it put back). Migration 79. Only the Assistant's changes are
 * here — the user's own clicks in Settings are not (the user chose that).
 *
 * Every write here is followed by `settingsChangeEvents` so Telegram can post its card.
 */

const log = createLogger("assistant-settings-changes");
const DAY_MS = 24 * 60 * 60_000;

export interface NewSettingChange {
  sessionId: string | null;
  origin: SettingChangeOrigin;
  approval: SettingChangeApproval;
  kind: SettingChangeKind;
  key: string;
  label: string;
  before: unknown;
  after: unknown;
  beforeText: string | null;
  afterText: string | null;
  note?: string | null;
  undoes?: number | null;
}

type Listener = (row: SettingChangeRow) => void;
const listeners = new Set<Listener>();

/** Told after every row written, the undo rows included. A listener that throws is logged and skipped. */
export const settingsChangeEvents = {
  on(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

interface DbRow {
  id: number; at: number; session_id: string | null; origin: string; approval: string; kind: string; key: string; label: string;
  before_json: string | null; after_json: string | null; before_text: string | null; after_text: string | null; note: string | null;
  undoes: number | null; undone_at: number | null; undone_by: number | null;
}

const parse = (json: string | null): unknown => {
  if (json === null) return null;
  try { return JSON.parse(json); } catch { return null; }
};

function toRow(r: DbRow): SettingChangeRow {
  return {
    id: r.id, at: r.at, sessionId: r.session_id, origin: r.origin as SettingChangeOrigin, approval: r.approval as SettingChangeApproval,
    kind: r.kind as SettingChangeKind, key: r.key, label: r.label, before: parse(r.before_json), after: parse(r.after_json),
    beforeText: r.before_text, afterText: r.after_text, note: r.note, undoes: r.undoes, undoneAt: r.undone_at, undoneBy: r.undone_by,
  };
}

/** Tells every open PPM the log moved; loaded on use so this module stays importable without sockets. */
function announce(): void {
  void import("../../server/ws/global.ts")
    .then(({ broadcastGlobalEvent }) => broadcastGlobalEvent({ type: SETTING_CHANGES_EVENT }))
    .catch(() => { /* no socket layer in this process: nobody to tell */ });
}

const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

/** Stores one change and tells the listeners; answers the stored row. */
export function recordSettingChange(change: NewSettingChange, now = Date.now()): SettingChangeRow {
  const db = getDb();
  db.query("DELETE FROM assistant_setting_changes WHERE at < ?").run(now - SETTING_CHANGES_RETENTION_DAYS * DAY_MS);
  const result = db.query(`
    INSERT INTO assistant_setting_changes (at, session_id, origin, approval, kind, key, label, before_json, after_json, before_text, after_text, note, undoes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    now, change.sessionId, change.origin, change.approval, change.kind, change.key, change.label, json(change.before), json(change.after),
    change.beforeText, change.afterText, change.note ?? null, change.undoes ?? null,
  );
  const row = getSettingChange(Number(result.lastInsertRowid))!;
  for (const listener of [...listeners]) {
    try { listener(row); } catch (e) { log.warn(`settings change listener failed: ${(e as Error).message}`); }
  }
  announce();
  return row;
}

export function getSettingChange(id: number): SettingChangeRow | null {
  const r = getDb().query("SELECT * FROM assistant_setting_changes WHERE id = ?").get(id) as DbRow | null;
  return r ? toRow(r) : null;
}

/** Newest first. `key` narrows to one setting. */
export function listSettingChanges(opts: { limit?: number; key?: string } = {}): SettingChangeRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = opts.key
    ? getDb().query("SELECT * FROM assistant_setting_changes WHERE key = ? ORDER BY id DESC LIMIT ?").all(opts.key, limit)
    : getDb().query("SELECT * FROM assistant_setting_changes ORDER BY id DESC LIMIT ?").all(limit);
  return (rows as DbRow[]).map(toRow);
}

/** Claims `id` for an undo about to be written; false when another undo holds or did it. */
export function claimSettingChangeUndo(id: number, now = Date.now()): boolean {
  return getDb().query("UPDATE assistant_setting_changes SET undone_at = ? WHERE id = ? AND undone_at IS NULL").run(now, id).changes > 0;
}

/** Gives a claim back after the write failed, so the change can be undone later. */
export function releaseSettingChangeUndo(id: number): void {
  getDb().query("UPDATE assistant_setting_changes SET undone_at = NULL WHERE id = ? AND undone_by IS NULL").run(id);
}

/** Marks `id` as undone by row `by`, only if no other undo did it first; false when one did. */
export function markSettingChangeUndone(id: number, by: number, now = Date.now()): boolean {
  const result = getDb().query("UPDATE assistant_setting_changes SET undone_at = ?, undone_by = ? WHERE id = ? AND undone_by IS NULL").run(now, by, id);
  if (result.changes > 0) announce();
  return result.changes > 0;
}
