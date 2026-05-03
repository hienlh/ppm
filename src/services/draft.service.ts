import { getDb } from "./db.service.ts";

const MAX_CONTENT_LENGTH = 50 * 1024; // ~50K characters cap

export interface DraftData {
  content: string;
  attachments: string; // JSON string
  updatedAt: string;
}

class DraftService {
  get(projectPath: string, sessionId: string): DraftData | null {
    const row = getDb()
      .query("SELECT content, attachments, updated_at FROM chat_drafts WHERE project_path = ? AND session_id = ?")
      .get(projectPath, sessionId) as { content: string; attachments: string; updated_at: string } | null;
    if (!row) return null;
    return { content: row.content, attachments: row.attachments, updatedAt: row.updated_at };
  }

  upsert(projectPath: string, sessionId: string, content: string, attachments?: string): void {
    // Silent truncation at 50KB
    const safeContent = content.length > MAX_CONTENT_LENGTH ? content.slice(0, MAX_CONTENT_LENGTH) : content;
    getDb()
      .query(
        "INSERT INTO chat_drafts (project_path, session_id, content, attachments, updated_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(project_path, session_id) DO UPDATE SET content = excluded.content, attachments = excluded.attachments, updated_at = excluded.updated_at",
      )
      .run(projectPath, sessionId, safeContent, attachments ?? "[]");
  }

  delete(projectPath: string, sessionId: string): void {
    getDb()
      .query("DELETE FROM chat_drafts WHERE project_path = ? AND session_id = ?")
      .run(projectPath, sessionId);
  }

  /** Delete orphaned drafts whose session_id is not in session_metadata */
  deleteOrphaned(): number {
    const result = getDb()
      .query(
        `DELETE FROM chat_drafts
         WHERE session_id != '__new__'
           AND session_id NOT IN (SELECT session_id FROM session_metadata)`,
      )
      .run();
    return (result as { changes: number }).changes;
  }
}

export const draftService = new DraftService();
