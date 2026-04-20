import { getDb } from "./db.service.ts";
import type { ProjectTag } from "../types/chat.ts";

const DEFAULT_TAGS = [
  { name: "Todo", color: "#22c55e", sort: 0 },
  { name: "In Progress", color: "#3b82f6", sort: 1 },
  { name: "Review", color: "#f59e0b", sort: 2 },
  { name: "Done", color: "#8b5cf6", sort: 3 },
];

/** Seed default tags for a project (idempotent via INSERT OR IGNORE) */
export function seedDefaultTags(projectPath: string): void {
  for (const t of DEFAULT_TAGS) {
    getDb().query(
      "INSERT OR IGNORE INTO project_tags (project_path, name, color, sort_order) VALUES (?, ?, ?, ?)",
    ).run(projectPath, t.name, t.color, t.sort);
  }
}

export function getTagsByProject(projectPath: string): ProjectTag[] {
  return getDb().query(
    "SELECT id, project_path AS projectPath, name, color, sort_order AS sortOrder FROM project_tags WHERE project_path = ? ORDER BY sort_order, id",
  ).all(projectPath) as ProjectTag[];
}

export function getTagById(id: number): ProjectTag | null {
  return getDb().query(
    "SELECT id, project_path AS projectPath, name, color, sort_order AS sortOrder FROM project_tags WHERE id = ?",
  ).get(id) as ProjectTag | null;
}

export function createTag(projectPath: string, name: string, color: string): ProjectTag {
  const maxOrder = (getDb().query(
    "SELECT COALESCE(MAX(sort_order), -1) AS m FROM project_tags WHERE project_path = ?",
  ).get(projectPath) as { m: number }).m;
  getDb().query(
    "INSERT INTO project_tags (project_path, name, color, sort_order) VALUES (?, ?, ?, ?)",
  ).run(projectPath, name, color, maxOrder + 1);
  const row = getDb().query(
    "SELECT id, project_path AS projectPath, name, color, sort_order AS sortOrder FROM project_tags WHERE project_path = ? AND name = ?",
  ).get(projectPath, name) as ProjectTag;
  return row;
}

export function updateTag(id: number, updates: { name?: string; color?: string; sortOrder?: number }): void {
  const parts: string[] = [];
  const values: (string | number)[] = [];
  if (updates.name !== undefined) { parts.push("name = ?"); values.push(updates.name); }
  if (updates.color !== undefined) { parts.push("color = ?"); values.push(updates.color); }
  if (updates.sortOrder !== undefined) { parts.push("sort_order = ?"); values.push(updates.sortOrder); }
  if (parts.length === 0) return;
  values.push(id);
  getDb().query(`UPDATE project_tags SET ${parts.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteTag(id: number): void {
  getDb().query("DELETE FROM project_tags WHERE id = ?").run(id);
}

/** Bulk-fetch tag info for a list of session IDs (JOIN session_metadata + project_tags) */
export function getSessionTags(
  sessionIds: string[],
): Record<string, { id: number; name: string; color: string }> {
  if (sessionIds.length === 0) return {};
  const placeholders = sessionIds.map(() => "?").join(", ");
  const rows = getDb().query(
    `SELECT sm.session_id, pt.id, pt.name, pt.color
     FROM session_metadata sm
     JOIN project_tags pt ON sm.tag_id = pt.id
     WHERE sm.session_id IN (${placeholders})`,
  ).all(...sessionIds) as { session_id: string; id: number; name: string; color: string }[];
  const result: Record<string, { id: number; name: string; color: string }> = {};
  for (const r of rows) result[r.session_id] = { id: r.id, name: r.name, color: r.color };
  return result;
}

export function setSessionTag(sessionId: string, tagId: number | null, projectPath?: string): void {
  if (projectPath) {
    // UPSERT: create session_metadata row if missing (e.g. sessions discovered from JSONL)
    getDb().query(
      `INSERT INTO session_metadata (session_id, tag_id, project_path)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET tag_id = excluded.tag_id,
       project_path = COALESCE(session_metadata.project_path, excluded.project_path)`,
    ).run(sessionId, tagId, projectPath);
  } else {
    getDb().query("UPDATE session_metadata SET tag_id = ? WHERE session_id = ?").run(tagId, sessionId);
  }
}

export function bulkSetSessionTag(sessionIds: string[], tagId: number | null, projectPath?: string): void {
  for (const id of sessionIds) setSessionTag(id, tagId, projectPath);
}

export function getTagSessionCounts(projectPath: string): Record<number, number> {
  const rows = getDb().query(
    `SELECT sm.tag_id, COUNT(*) AS cnt
     FROM session_metadata sm
     WHERE sm.tag_id IS NOT NULL AND sm.project_path = ?
     GROUP BY sm.tag_id`,
  ).all(projectPath) as { tag_id: number; cnt: number }[];
  const result: Record<number, number> = {};
  for (const r of rows) result[r.tag_id] = r.cnt;
  return result;
}

export function setProjectDefaultTag(projectPath: string, tagId: number | null): void {
  getDb().query("UPDATE projects SET default_tag_id = ? WHERE path = ?").run(tagId, projectPath);
}

export function getProjectDefaultTagId(projectPath: string): number | null {
  const row = getDb().query("SELECT default_tag_id FROM projects WHERE path = ?").get(projectPath) as { default_tag_id: number | null } | null;
  return row?.default_tag_id ?? null;
}
