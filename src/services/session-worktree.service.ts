/**
 * Which chats run in a git worktree of their own, as their CLI reported it (`init.cwd` under
 * `<project>/.claude/worktrees/`). The CLI keeps the session's transcript under the worktree's
 * path, not the project's, so this record is what lets PPM prove the session is still the
 * project's (`pinClaudeSessionDir`) and show which branch the chat works on.
 *
 * Its own table, created on first use rather than by a numbered migration, for the same reason as
 * `session-archive.service.ts`.
 */
import { appendFile, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { getDb } from "./db.service.ts";
import { createLogger } from "./logger.ts";
import { WORKTREE_NAME_RE, type SessionWorktree } from "../shared/session-worktree.ts";

const log = createLogger("session-worktree");

let ensured: unknown = null;
function db() {
  const d = getDb();
  if (ensured !== d) {
    d.exec("CREATE TABLE IF NOT EXISTS session_worktrees (session_id TEXT PRIMARY KEY, project_path TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
    ensured = d;
  }
  return d;
}

/** Where Claude Code puts a project's worktrees. */
export function worktreesRoot(projectPath: string): string {
  return join(resolve(projectPath), ".claude", "worktrees");
}

/** The worktree `cwd` names, when it is one of the project's own; null otherwise. */
export function worktreeOfCwd(projectPath: string, cwd: string | undefined): SessionWorktree | null {
  if (!cwd || !isAbsolute(cwd)) return null;
  const root = worktreesRoot(projectPath);
  const path = resolve(cwd);
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  if (!norm(path).startsWith(norm(root) + sep)) return null;
  const name = basename(path);
  if (resolve(root, name) !== path || !WORKTREE_NAME_RE.test(name)) return null;
  return { name, path, branch: "worktree-" + name };
}

interface Row { project_path: string; path: string; branch: string }

/** Record the chat's worktree (once; later reports change nothing). */
export function recordSessionWorktree(sessionId: string, projectPath: string, wt: SessionWorktree): void {
  db().query("INSERT OR IGNORE INTO session_worktrees (session_id, project_path, path, branch) VALUES (?, ?, ?, ?)")
    .run(sessionId, resolve(projectPath), wt.path, wt.branch);
}

export function getSessionWorktree(sessionId: string): (SessionWorktree & { projectPath: string }) | null {
  const r = db().query("SELECT project_path, path, branch FROM session_worktrees WHERE session_id = ?").get(sessionId) as Row | null;
  return r ? { name: basename(r.path), path: r.path, branch: r.branch, projectPath: r.project_path } : null;
}

/** Each listed session's worktree; a session with none is absent. */
export function getSessionWorktrees(sessionIds: readonly string[]): Map<string, SessionWorktree> {
  const out = new Map<string, SessionWorktree>();
  if (sessionIds.length === 0) return out;
  const want = new Set(sessionIds);
  const rows = db().query("SELECT session_id, path, branch FROM session_worktrees").all() as Array<Row & { session_id: string }>;
  for (const r of rows) if (want.has(r.session_id)) out.set(r.session_id, { name: basename(r.path), path: r.path, branch: r.branch });
  return out;
}

const EXCLUDE_LINE = "/.claude/worktrees/";

/**
 * Keep the project's worktrees out of its own Source Control: a line in the repository's
 * `info/exclude`, which is local to this clone and never committed. Best effort — a project that
 * is not a repository, or a git that cannot be run, is left as it is.
 */
export async function excludeWorktreesFromGit(projectPath: string): Promise<void> {
  try {
    const proc = Bun.spawn(["git", "-C", projectPath, "rev-parse", "--path-format=absolute", "--git-common-dir"], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) !== 0 || !out) return;
    const file = join(out, "info", "exclude");
    const current = await readFile(file, "utf8").catch(() => "");
    if (current.split(/\r?\n/).includes(EXCLUDE_LINE)) return;
    await appendFile(file, (current && !current.endsWith("\n") ? "\n" : "") + EXCLUDE_LINE + "\n");
  } catch (e) {
    log.debug("could not exclude worktrees in " + projectPath + ": " + (e as Error).message);
  }
}
