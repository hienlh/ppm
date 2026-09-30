/**
 * Where Claude Code writes per-project session transcripts
 * (`<root>/<slug(projectPath)>/<sessionId>.jsonl`).
 *
 * Real home by default; overridable so session-ownership and transcript-source
 * tests never read or write the user's actual `~/.claude/projects`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

let override: string | null = null;

export function claudeProjectsRoot(): string {
  return override ?? join(homedir(), ".claude", "projects");
}

/** Test-only: point claudeProjectsRoot() at a scratch directory. Pass null to reset. */
export function _setClaudeProjectsRoot(root: string | null): void {
  override = root;
}
