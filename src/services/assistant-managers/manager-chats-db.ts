import { getDb, resolveMigratedSession } from "../db.service.ts";
import { MANAGER_TELEGRAM_DETAILS, type ManagerTelegramDetail } from "../../shared/assistant-managers.ts";

/**
 * Storage for manager chats (`manager_chats`, migration 64): one row per project, keyed by the
 * project's folder in `projectKey` spelling. Session ids are stored as given and answered with the
 * id the session goes by now; lookups by session compare current ids. A project's own settings
 * outlive its manager in `manager_project_settings` (migration 67).
 */

export interface ManagerChatRow {
  projectKey: string;
  projectPath: string;
  /** The chat's current id. */
  sessionId: string;
  providerId: string;
  digest: boolean;
  telegramDetail: ManagerTelegramDetail;
  rulesPendingHash: string | null;
  assignedBy: "user" | "assistant";
  assignedAt: number;
}

interface Row {
  project_key: string;
  project_path: string;
  session_id: string;
  provider_id: string;
  digest: number;
  telegram_detail: string;
  rules_pending_hash: string | null;
  assigned_by: string;
  assigned_at: number;
}

const toRow = (r: Row): ManagerChatRow => ({
  projectKey: r.project_key,
  projectPath: r.project_path,
  sessionId: resolveMigratedSession(r.session_id),
  providerId: r.provider_id,
  digest: r.digest === 1,
  telegramDetail: r.telegram_detail === "title" ? "title" : "full",
  rulesPendingHash: r.rules_pending_hash,
  assignedBy: r.assigned_by === "assistant" ? "assistant" : "user",
  assignedAt: r.assigned_at,
});

const SELECT = "SELECT project_key, project_path, session_id, provider_id, digest, telegram_detail, rules_pending_hash, assigned_by, assigned_at FROM manager_chats";

export function listManagerChatRows(): ManagerChatRow[] {
  return (getDb().query(`${SELECT} ORDER BY assigned_at`).all() as Row[]).map(toRow);
}

export function getManagerChatRow(projectKey: string): ManagerChatRow | null {
  const row = getDb().query(`${SELECT} WHERE project_key = ?`).get(projectKey) as Row | null;
  return row ? toRow(row) : null;
}

export interface NewManagerChat {
  projectKey: string;
  projectPath: string;
  sessionId: string;
  providerId: string;
  assignedBy: "user" | "assistant";
  assignedAt: number;
}

/** The project-owned columns of a manager row, kept in `manager_project_settings` while it has none. */
const SETTINGS = "digest, telegram_detail, rules_approved, rules_accepted, rules_proposed, rules_pending_hash, rules_approved_at";

/**
 * Removes a project's manager row, keeping what belongs to the project (digest, Telegram detail,
 * rules) for the next chat that manages it. Runs inside the caller's transaction.
 */
function retireRow(projectKey: string): boolean {
  const db = getDb();
  db.query(`INSERT OR REPLACE INTO manager_project_settings (project_key, ${SETTINGS})
    SELECT project_key, ${SETTINGS} FROM manager_chats WHERE project_key = ?`).run(projectKey);
  return db.query("DELETE FROM manager_chats WHERE project_key = ?").run(projectKey).changes > 0;
}

/**
 * Makes the chat the project's manager. Replaces the project's previous row and removes any row
 * the chat held for another project (under any of its ids), in one transaction. The project's
 * settings (digest, Telegram detail, rules) belong to the project: a replaced row keeps them, and
 * a project that had a manager before gets back the ones kept when that one went.
 */
export function putManagerChatRow(input: NewManagerChat): void {
  const db = getDb();
  const current = resolveMigratedSession(input.sessionId);
  db.transaction(() => {
    for (const row of listManagerChatRows()) {
      if (row.sessionId === current && row.projectKey !== input.projectKey) retireRow(row.projectKey);
    }
    db.query(`
      INSERT INTO manager_chats (project_key, project_path, session_id, provider_id, assigned_by, assigned_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_key) DO UPDATE SET
        project_path = excluded.project_path, session_id = excluded.session_id, provider_id = excluded.provider_id,
        assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at
    `).run(input.projectKey, input.projectPath, current, input.providerId, input.assignedBy, input.assignedAt);
    const kept = db.query(`SELECT ${SETTINGS} FROM manager_project_settings WHERE project_key = ?`).get(input.projectKey) as KeptSettings | null;
    if (!kept) return;
    db.query(`UPDATE manager_chats SET digest = ?, telegram_detail = ?, rules_approved = ?, rules_accepted = ?, rules_proposed = ?,
      rules_pending_hash = ?, rules_approved_at = ? WHERE project_key = ?`).run(
      kept.digest, kept.telegram_detail, kept.rules_approved, kept.rules_accepted, kept.rules_proposed,
      kept.rules_pending_hash, kept.rules_approved_at, input.projectKey,
    );
    db.query("DELETE FROM manager_project_settings WHERE project_key = ?").run(input.projectKey);
  })();
}

interface KeptSettings {
  digest: number; telegram_detail: string; rules_approved: string | null; rules_accepted: string | null;
  rules_proposed: string | null; rules_pending_hash: string | null; rules_approved_at: number | null;
}

/** False when the project had no manager. Its settings are kept for the next one. */
export function deleteManagerChatRow(projectKey: string): boolean {
  return getDb().transaction(() => retireRow(projectKey))();
}

/** Removes the row a chat holds, under any of its ids; the project keys it was manager of. */
export function deleteManagerChatRowsFor(sessionId: string): string[] {
  const current = resolveMigratedSession(sessionId);
  const keys = listManagerChatRows().filter((r) => r.sessionId === current || r.sessionId === sessionId).map((r) => r.projectKey);
  getDb().transaction(() => { for (const key of keys) retireRow(key); })();
  return keys;
}

/**
 * How much of a project's cards may reach Telegram: its manager's setting, else the one kept from
 * its last manager; null for a project that never had one.
 */
export function projectTelegramDetail(projectKey: string): ManagerTelegramDetail | null {
  const db = getDb();
  const row = (db.query("SELECT telegram_detail FROM manager_chats WHERE project_key = ?").get(projectKey)
    ?? db.query("SELECT telegram_detail FROM manager_project_settings WHERE project_key = ?").get(projectKey)) as { telegram_detail: string } | null;
  if (!row) return null;
  return row.telegram_detail === "title" ? "title" : "full";
}

export interface ManagerChatPatch {
  digest?: boolean;
  telegramDetail?: ManagerTelegramDetail;
}

/** False when the project has no manager. */
export function patchManagerChatRow(projectKey: string, patch: ManagerChatPatch): boolean {
  const sets: string[] = [];
  const values: Array<string | number> = [];
  if (patch.digest !== undefined) { sets.push("digest = ?"); values.push(patch.digest ? 1 : 0); }
  if (patch.telegramDetail !== undefined) {
    if (!MANAGER_TELEGRAM_DETAILS.includes(patch.telegramDetail)) throw new Error(`Unknown Telegram detail "${String(patch.telegramDetail)}"`);
    sets.push("telegram_detail = ?");
    values.push(patch.telegramDetail);
  }
  if (sets.length === 0) return getManagerChatRow(projectKey) !== null;
  return getDb().query(`UPDATE manager_chats SET ${sets.join(", ")} WHERE project_key = ?`).run(...values, projectKey).changes > 0;
}
