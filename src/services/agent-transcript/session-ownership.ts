/**
 * Prove a session belongs to the requesting project before any transcript file
 * is named. Everything an Agent card window reads is derived from this result
 * — never from a client-supplied path.
 *
 * Claude: the session's own JSONL must sit under `<claudeRoot>/<slug(projectPath)>/`.
 * A session started outside PPM (no DB row) is accepted on that basis alone; the
 * cross-project fallback (DB `project_path`, drive-letter/case drift) is used
 * only when it independently names the SAME project the caller asked for.
 *
 * Codex: the root rollout must be found by `findRolloutByThreadId`, which is
 * itself fail-closed on `cwd` — a rollout whose recorded cwd does not match
 * `projectPath` is never returned. `dirsFn` is injectable so tests never touch
 * the real `~/.codex`.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { getSessionProjectPath } from "../db.service.ts";
import { codexSessionsDirs as realCodexSessionsDirs } from "../../providers/codex-app-server/codex-provider.ts";
import { findRolloutByThreadId, isCodexRolloutPath } from "../../providers/codex-app-server/codex-history.ts";
import { claudeProjectsRoot } from "./claude-projects-root.ts";

export const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type OwnershipErrorCode =
  | "invalid_session_id"
  | "invalid_provider"
  | "invalid_project"
  | "session_not_found";

export interface OwnershipError {
  ok: false;
  code: OwnershipErrorCode;
}

export interface OwnedSession {
  ok: true;
  providerId: "claude" | "codex";
  sessionId: string;
  projectPath: string;
  /** Claude only: the session's own directory, `<claudeRoot>/<slug>/<sessionId>`. */
  claude?: { sessionDir: string };
  /** Codex only: where the root rollout was found, plus every dir it was searched in
   *  (reused by agent-transcript-sources so a descendant lookup need not re-derive it). */
  codex?: { path: string; sessionsDir: string; dirs: string[] };
}

export interface AssertSessionParams {
  providerId: string;
  sessionId: string;
  projectPath: string;
  /** Test-only: override which directories Codex rollouts are searched under. */
  codexSessionsDirs?: (sessionId?: string) => string[];
}

/**
 * Test-only fallback for callers that cannot pass `codexSessionsDirs` per
 * call (the `/ws/global` hub never accepts a client-supplied directory list,
 * by design) but still need Codex fixtures to live outside the real
 * `~/.codex`. `codex-provider.ts`'s real `codexSessionsDirs` freezes
 * `homedir()` into a module-level constant at import time, so patching
 * `HOME`/`USERPROFILE` in a `beforeEach` has no effect on it once any test in
 * the same process has already imported that module.
 */
let testCodexSessionsDirsOverride: ((sessionId?: string) => string[]) | null = null;

export function _setCodexSessionsDirsForTest(fn: ((sessionId?: string) => string[]) | null): void {
  testCodexSessionsDirsOverride = fn;
}

/** Absolute path normalized for cross-platform / case-insensitive (win32) comparison. */
function normalizeProjectPath(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/** Same encoding `resolveSessionDir` (subagent-transcript-merger.ts) uses. */
function encodeClaudeSlug(projectPath: string): string {
  return projectPath.replace(/[/\\:.]/g, "-");
}

function isWithin(child: string, root: string): boolean {
  const c = process.platform === "win32" ? child.toLowerCase() : child;
  const r = process.platform === "win32" ? root.toLowerCase() : root;
  return c === r || c.startsWith(r + sep);
}

/** Realpath `path` and confirm it stays under `root`'s realpath. Null on any failure. */
export function realpathContained(path: string, root: string): string | null {
  try {
    const real = realpathSync(path);
    const realRoot = realpathSync(root);
    return isWithin(real, realRoot) ? real : null;
  } catch {
    return null;
  }
}

/**
 * Pin a Claude session id to a project: its JSONL must sit directly under
 * `<claudeRoot>/<slug(projectPath)>/`, or — only when the DB independently
 * names the SAME project (drive-letter/case drift) — under the slug the DB
 * recorded. Returns the session's own directory (sibling of the JSONL),
 * realpath-contained under `claudeRoot`. Shared by the primary-session check
 * and the `member` source's `teamName` (a team is itself a session id).
 */
export function pinClaudeSessionDir(sessionId: string, projectPath: string): string | null {
  const root = claudeProjectsRoot();
  let jsonlFile = join(root, encodeClaudeSlug(projectPath), `${sessionId}.jsonl`);
  if (!existsSync(jsonlFile)) {
    const recorded = getSessionProjectPath(sessionId);
    if (!recorded || normalizeProjectPath(recorded) !== normalizeProjectPath(projectPath)) return null;
    jsonlFile = join(root, encodeClaudeSlug(recorded), `${sessionId}.jsonl`);
    if (!existsSync(jsonlFile)) return null;
  }
  const real = realpathContained(jsonlFile, root);
  if (!real) return null;
  // sessionId is regex-validated (no separators, no "..") so this join cannot escape the slug dir.
  return join(dirname(real), sessionId);
}

function assertClaudeSession(sessionId: string, projectPath: string): OwnedSession | OwnershipError {
  const sessionDir = pinClaudeSessionDir(sessionId, projectPath);
  if (!sessionDir) return { ok: false, code: "session_not_found" };
  return { ok: true, providerId: "claude", sessionId, projectPath, claude: { sessionDir } };
}

function assertCodexSession(
  sessionId: string,
  projectPath: string,
  dirsFn: (sessionId?: string) => string[],
): OwnedSession | OwnershipError {
  const dirs = dirsFn(sessionId);
  for (const dir of dirs) {
    const file = findRolloutByThreadId(dir, sessionId, projectPath);
    if (!file || !isCodexRolloutPath(file)) continue;
    return { ok: true, providerId: "codex", sessionId, projectPath, codex: { path: file, sessionsDir: dir, dirs } };
  }
  return { ok: false, code: "session_not_found" };
}

export function assertSessionInProject(params: AssertSessionParams): OwnedSession | OwnershipError {
  const { providerId, sessionId, projectPath } = params;
  if (!SESSION_ID_RE.test(sessionId)) return { ok: false, code: "invalid_session_id" };
  if (!projectPath) return { ok: false, code: "invalid_project" };
  if (providerId === "claude") return assertClaudeSession(sessionId, projectPath);
  if (providerId === "codex") {
    return assertCodexSession(sessionId, projectPath, params.codexSessionsDirs ?? testCodexSessionsDirsOverride ?? realCodexSessionsDirs);
  }
  return { ok: false, code: "invalid_provider" };
}
