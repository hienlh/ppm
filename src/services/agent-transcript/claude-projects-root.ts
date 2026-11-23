/**
 * Where Claude Code writes per-project session transcripts
 * (`<root>/<slug(projectPath)>/<sessionId>.jsonl`).
 *
 * The CLI PPM spawns inherits PPM's environment, so it writes under `CLAUDE_CONFIG_DIR` when that
 * is set and under `~/.claude` otherwise. Every place PPM looks for a transcript has to look there
 * too: reading `~/.claude` while the CLI writes elsewhere made PPM resume a conversation the CLI
 * could not find ("No conversation found"), or start over one it still had.
 *
 * Overridable so session-ownership and transcript-source tests never read or write the user's
 * actual transcripts.
 */

import { homedir } from "node:os";
import { join } from "node:path";

let override: string | null = null;

/** Claude Code's own folder: `CLAUDE_CONFIG_DIR`, else `~/.claude`. Read per call. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function claudeProjectsRoot(): string {
  return override ?? join(claudeConfigDir(), "projects");
}

/** Test-only: point claudeProjectsRoot() at a scratch directory. Pass null to reset. */
export function _setClaudeProjectsRoot(root: string | null): void {
  override = root;
}
