import { decodeMessageBlocks, encodeMessageBlocks } from "../shared/chat-message-blocks.ts";
import { decodeStoredVoiceDraft, parseStoredVoiceDraft, type StoredVoiceDraft } from "../shared/voice-draft.ts";
import { getDb } from "./db.service.ts";

const MAX_CONTENT_LENGTH = 50 * 1024; // ~50K characters cap

export interface DraftData {
  content: string;
  attachments: string; // JSON string
  /** The composer's voice message, checked again on the way out; null when there is none. */
  voice: StoredVoiceDraft | null;
  updatedAt: string;
}

class DraftService {
  get(projectPath: string, sessionId: string): DraftData | null {
    const row = getDb()
      .query("SELECT content, attachments, voice, updated_at FROM chat_drafts WHERE project_path = ? AND session_id = ?")
      .get(projectPath, sessionId) as { content: string; attachments: string; voice: string | null; updated_at: string } | null;
    if (!row) return null;
    return { content: row.content, attachments: row.attachments, voice: decodeStoredVoiceDraft(row.voice), updatedAt: row.updated_at };
  }

  /**
   * `voice` is the value as the request sent it. `undefined` (no `voice` key: a bundle from before
   * voice drafts) leaves the stored voice as it is, so editing the text there does not drop a voice
   * recorded on another device; `null`, or anything that is not a valid voice draft, clears it.
   */
  upsert(projectPath: string, sessionId: string, content: string, attachments?: string, voice?: unknown): void {
    // Silent truncation at 50KB
    const decoded = decodeMessageBlocks(content);
    const body = decoded.content.length > MAX_CONTENT_LENGTH ? decoded.content.slice(0, MAX_CONTENT_LENGTH) : decoded.content;
    // A draft is the person's own text: a from-session block in it is never carried over.
    const safeContent = encodeMessageBlocks(body, { turnRefs: decoded.turnRefs, replyTo: decoded.replyTo });
    const keepVoice = voice === undefined;
    const parsed = keepVoice ? null : parseStoredVoiceDraft(voice);
    getDb()
      .query(
        `INSERT INTO chat_drafts (project_path, session_id, content, attachments, voice, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(project_path, session_id) DO UPDATE SET content = excluded.content, attachments = excluded.attachments,
           voice = ${keepVoice ? "chat_drafts.voice" : "excluded.voice"}, updated_at = excluded.updated_at`,
      )
      .run(projectPath, sessionId, safeContent, attachments ?? "[]", parsed ? JSON.stringify(parsed) : null);
  }

  delete(projectPath: string, sessionId: string): void {
    getDb()
      .query("DELETE FROM chat_drafts WHERE project_path = ? AND session_id = ?")
      .run(projectPath, sessionId);
  }

  /**
   * Delete orphaned drafts whose session_id is not in session_metadata.
   * `git-commit` rows are commit messages (`git-commit-draft.service.ts`), not
   * chat drafts, and have no session.
   */
  deleteOrphaned(): number {
    const result = getDb()
      .query(
        `DELETE FROM chat_drafts
         WHERE session_id NOT IN ('__new__', 'git-commit')
           AND session_id NOT IN (SELECT session_id FROM session_metadata)`,
      )
      .run();
    return (result as { changes: number }).changes;
  }
}

export const draftService = new DraftService();
