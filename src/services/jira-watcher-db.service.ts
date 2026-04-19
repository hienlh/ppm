import { getDb } from "./db.service.ts";
import type {
  JiraWatcherRow, JiraWatchResultRow,
  JiraWatcher, JiraWatchResult, JiraWatcherMode, JiraResultStatus,
} from "../types/jira.ts";

// ── Row → API mappers ─────────────────────────────────────────────────

export function rowToWatcher(row: JiraWatcherRow): JiraWatcher {
  return {
    id: row.id,
    jiraConfigId: row.jira_config_id,
    name: row.name,
    jql: row.jql,
    promptTemplate: row.prompt_template,
    enabled: row.enabled === 1,
    mode: row.mode as JiraWatcherMode,
    intervalMs: row.interval_ms,
    lastPolledAt: row.last_polled_at,
    createdAt: row.created_at,
  };
}

export function rowToResult(row: JiraWatchResultRow): JiraWatchResult {
  return {
    id: row.id,
    watcherId: row.watcher_id,
    issueKey: row.issue_key,
    issueSummary: row.issue_summary,
    issueUpdated: row.issue_updated,
    sessionId: row.session_id,
    status: row.status,
    aiSummary: row.ai_summary,
    source: row.source,
    readAt: row.read_at,
    triggeredBy: row.triggered_by,
    createdAt: row.created_at,
  };
}

// ── Watcher CRUD ──────────────────────────────────────────────────────

export function createWatcher(
  configId: number, name: string, jql: string,
  opts?: { promptTemplate?: string; intervalMs?: number; mode?: JiraWatcherMode },
): JiraWatcher {
  const result = getDb().query(`
    INSERT INTO jira_watchers (jira_config_id, name, jql, prompt_template, interval_ms, mode)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING *
  `).get(
    configId, name, jql,
    opts?.promptTemplate ?? null,
    opts?.intervalMs ?? 120000,
    opts?.mode ?? "debug",
  ) as JiraWatcherRow;
  return rowToWatcher(result);
}

export function updateWatcher(
  id: number,
  fields: Partial<{ name: string; jql: string; promptTemplate: string | null; intervalMs: number; enabled: boolean; mode: JiraWatcherMode }>,
): JiraWatcher | null {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (fields.name !== undefined) { sets.push("name = ?"); params.push(fields.name); }
  if (fields.jql !== undefined) { sets.push("jql = ?"); params.push(fields.jql); }
  if (fields.promptTemplate !== undefined) { sets.push("prompt_template = ?"); params.push(fields.promptTemplate); }
  if (fields.intervalMs !== undefined) { sets.push("interval_ms = ?"); params.push(fields.intervalMs); }
  if (fields.enabled !== undefined) { sets.push("enabled = ?"); params.push(fields.enabled ? 1 : 0); }
  if (fields.mode !== undefined) { sets.push("mode = ?"); params.push(fields.mode); }
  if (sets.length === 0) return getWatcherById(id);
  params.push(id);
  getDb().query(`UPDATE jira_watchers SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getWatcherById(id);
}

export function deleteWatcher(id: number): boolean {
  return getDb().query("DELETE FROM jira_watchers WHERE id = ?").run(id).changes > 0;
}

export function getWatcherById(id: number): JiraWatcher | null {
  const row = getDb().query("SELECT * FROM jira_watchers WHERE id = ?").get(id) as JiraWatcherRow | null;
  return row ? rowToWatcher(row) : null;
}

export function getWatchersByConfigId(configId: number): JiraWatcher[] {
  const rows = getDb().query("SELECT * FROM jira_watchers WHERE jira_config_id = ? ORDER BY id")
    .all(configId) as JiraWatcherRow[];
  return rows.map(rowToWatcher);
}

export function getAllEnabledWatchers(): JiraWatcherRow[] {
  return getDb().query("SELECT * FROM jira_watchers WHERE enabled = 1")
    .all() as JiraWatcherRow[];
}

// ── Result CRUD ───────────────────────────────────────────────────────

/** Insert a result. Resurrects soft-deleted duplicates. Returns true if row was inserted or resurrected. */
export function insertResult(
  watcherId: number | null, issueKey: string,
  issueSummary: string | null, issueUpdated: string | null,
  source: "watcher" | "manual" = "watcher",
  triggeredBy: "auto" | "manual" = "auto",
): { inserted: boolean; resultId: number | null } {
  try {
    const row = getDb().query(`
      INSERT INTO jira_watch_results (watcher_id, issue_key, issue_summary, issue_updated, source, triggered_by)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id
    `).get(watcherId, issueKey, issueSummary, issueUpdated, source, triggeredBy) as { id: number } | null;
    return { inserted: true, resultId: row?.id ?? null };
  } catch (e: any) {
    if (e.message?.includes("UNIQUE constraint")) {
      // Resurrect soft-deleted row if it exists
      const resurrected = getDb().query(`
        UPDATE jira_watch_results
        SET deleted = 0, status = 'pending', session_id = NULL, ai_summary = NULL,
            read_at = NULL, triggered_by = ?, source = ?, created_at = datetime('now')
        WHERE watcher_id IS ? AND issue_key = ? AND issue_updated IS ? AND deleted = 1
        RETURNING id
      `).get(triggeredBy, source, watcherId, issueKey, issueUpdated) as { id: number } | null;
      if (resurrected) return { inserted: true, resultId: resurrected.id };
      return { inserted: false, resultId: null };
    }
    throw e;
  }
}

export function updateResultStatus(
  resultId: number,
  status: JiraResultStatus,
  updates?: { sessionId?: string; aiSummary?: string },
): void {
  const sets = ["status = ?"];
  const params: (string | number)[] = [status];
  if (updates?.sessionId !== undefined) { sets.push("session_id = ?"); params.push(updates.sessionId); }
  if (updates?.aiSummary !== undefined) { sets.push("ai_summary = ?"); params.push(updates.aiSummary); }
  params.push(resultId);
  getDb().query(`UPDATE jira_watch_results SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function getResultsByWatcherId(
  watcherId?: number,
  opts?: { status?: string; limit?: number; offset?: number; includeDeleted?: boolean },
): JiraWatchResult[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (watcherId !== undefined) { clauses.push("watcher_id = ?"); params.push(watcherId); }
  if (opts?.status) { clauses.push("status = ?"); params.push(opts.status); }
  if (!opts?.includeDeleted) clauses.push("deleted = 0");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;
  const rows = getDb()
    .query(`SELECT * FROM jira_watch_results ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as JiraWatchResultRow[];
  return rows.map(rowToResult);
}

export function getResultById(id: number): JiraWatchResult | null {
  const row = getDb().query("SELECT * FROM jira_watch_results WHERE id = ?")
    .get(id) as JiraWatchResultRow | null;
  return row ? rowToResult(row) : null;
}

export function softDeleteResult(id: number): boolean {
  return getDb().query("UPDATE jira_watch_results SET deleted = 1 WHERE id = ?").run(id).changes > 0;
}

export function getRunningResults(): JiraWatchResultRow[] {
  return getDb().query("SELECT * FROM jira_watch_results WHERE status = 'running'")
    .all() as JiraWatchResultRow[];
}

export function getWatcherStats(): Record<JiraResultStatus, number> {
  const rows = getDb().query(
    "SELECT status, COUNT(*) as count FROM jira_watch_results WHERE deleted = 0 GROUP BY status",
  ).all() as Array<{ status: JiraResultStatus; count: number }>;
  const stats: Record<string, number> = { pending: 0, queued: 0, running: 0, done: 0, failed: 0 };
  for (const r of rows) stats[r.status] = r.count;
  return stats as Record<JiraResultStatus, number>;
}

export function markResultRead(resultId: number): boolean {
  return getDb().query(
    "UPDATE jira_watch_results SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL",
  ).run(resultId).changes > 0;
}

export function getUnreadCount(): number {
  const row = getDb().query(
    "SELECT COUNT(*) as count FROM jira_watch_results WHERE status = 'done' AND read_at IS NULL AND deleted = 0",
  ).get() as { count: number };
  return row.count;
}
