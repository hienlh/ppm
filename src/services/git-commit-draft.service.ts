/**
 * The commit message being written for a repository — one per repository, not
 * one per screen.
 *
 * Source Control, the Review tab and the Git Graph inspector each have a
 * message box, and they are one box: typing in one shows up in the others, and
 * a commit from any of them clears all three. The server holds it so the Git
 * Graph panel, a sandboxed webview that can only reach PPM through its
 * extension, sees the same text, and so it survives a reload.
 *
 * Stored in `chat_drafts` under the session id `git-commit`, keyed by the
 * repository's real path, so no migration is needed;
 * `draftService.deleteOrphaned` leaves these rows alone.
 */
import { resolve } from "node:path";
import type { CommitDraft } from "../shared/git-changes.ts";
import { getDb } from "./db.service.ts";
import { realPathOrSelfSync } from "./fs-ops/fs-real-path.ts";

export const COMMIT_DRAFT_SESSION_ID = "git-commit";
const MAX_LENGTH = 50 * 1024;

function key(repo: string): string {
  return realPathOrSelfSync(resolve(repo));
}

export const gitCommitDraftService = {
  get(repo: string): CommitDraft {
    const row = getDb()
      .query("SELECT content, updated_at FROM chat_drafts WHERE project_path = ? AND session_id = ?")
      .get(key(repo), COMMIT_DRAFT_SESSION_ID) as { content: string; updated_at: string } | null;
    return row ? { message: row.content, updatedAt: row.updated_at } : { message: "", updatedAt: null };
  },

  /** An empty message deletes the draft. */
  set(repo: string, message: string): CommitDraft {
    const body = message.length > MAX_LENGTH ? message.slice(0, MAX_LENGTH) : message;
    if (!body.trim()) {
      getDb()
        .query("DELETE FROM chat_drafts WHERE project_path = ? AND session_id = ?")
        .run(key(repo), COMMIT_DRAFT_SESSION_ID);
      return { message: "", updatedAt: null };
    }
    getDb()
      .query(
        "INSERT INTO chat_drafts (project_path, session_id, content, attachments, updated_at) VALUES (?, ?, ?, '[]', datetime('now')) ON CONFLICT(project_path, session_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
      )
      .run(key(repo), COMMIT_DRAFT_SESSION_ID, body);
    return this.get(repo);
  },
};
