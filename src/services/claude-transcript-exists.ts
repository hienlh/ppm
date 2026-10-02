import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";

/** Root of Claude session JSONLs. Overridable via CLAUDE_PROJECTS_DIR for tests. */
function claudeProjectsDir(): string {
  return process.env.CLAUDE_PROJECTS_DIR || resolve(homedir(), ".claude", "projects");
}

/**
 * Whether `<sessionId>.jsonl` exists in any project folder under `~/.claude/projects`.
 *
 * This is evidence of ownership when `session_metadata.provider_id` is empty: a row written
 * by the unread upsert or the account claim carries no provider, and falling back to the
 * global default then resumes a claude session as codex ("transcript was not found").
 * Codex never writes here, so a hit means the session is claude's.
 */
export function claudeTranscriptExists(sessionId: string): boolean {
  if (!/^[\w-]+$/.test(sessionId)) return false;
  const root = claudeProjectsDir();
  let dirs: string[];
  try { dirs = readdirSync(root); } catch { return false; }
  return dirs.some((d) => existsSync(join(root, d, `${sessionId}.jsonl`)));
}
