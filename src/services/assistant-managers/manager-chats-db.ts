import { getDb, resolveMigratedSession } from "../db.service.ts";
import { MANAGER_TELEGRAM_DETAILS, type ManagerTelegramDetail } from "../../shared/assistant-managers.ts";

/**
 * Storage for manager chats (`manager_chats`, migration 64): one row per project, keyed by the
 * project's folder in `projectKey` spelling. Session ids are stored as given and answered with the
 * id the session goes by now; lookups by session compare current ids.
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

/**
 * Makes the chat the project's manager. Replaces the project's previous row and removes any row
 * the chat held for another project (under any of its ids), in one transaction. A replaced row's
 * settings (digest, Telegram detail) belong to the project and are kept.
 */
export function putManagerChatRow(input: NewManagerChat): void {
  const db = getDb();
  const current = resolveMigratedSession(input.sessionId);
  db.transaction(() => {
    for (const row of listManagerChatRows()) {
      if (row.sessionId === current && row.projectKey !== input.projectKey) {
        db.query("DELETE FROM manager_chats WHERE project_key = ?").run(row.projectKey);
      }
    }
    db.query(`
      INSERT INTO manager_chats (project_key, project_path, session_id, provider_id, assigned_by, assigned_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_key) DO UPDATE SET
        project_path = excluded.project_path, session_id = excluded.session_id, provider_id = excluded.provider_id,
        assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at
    `).run(input.projectKey, input.projectPath, current, input.providerId, input.assignedBy, input.assignedAt);
  })();
}

/** False when the project had no manager. */
export function deleteManagerChatRow(projectKey: string): boolean {
  return getDb().query("DELETE FROM manager_chats WHERE project_key = ?").run(projectKey).changes > 0;
}

/** Removes the row a chat holds, under any of its ids; the project keys it was manager of. */
export function deleteManagerChatRowsFor(sessionId: string): string[] {
  const current = resolveMigratedSession(sessionId);
  const keys = listManagerChatRows().filter((r) => r.sessionId === current || r.sessionId === sessionId).map((r) => r.projectKey);
  const remove = getDb().query("DELETE FROM manager_chats WHERE project_key = ?");
  for (const key of keys) remove.run(key);
  return keys;
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
