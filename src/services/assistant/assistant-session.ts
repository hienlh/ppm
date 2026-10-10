import { resolve } from "node:path";
import { getSessionIsAssistant, getSessionProjectPath, resolveMigratedSession } from "../db.service.ts";
import { assistantWorkDir } from "./assistant-work-dir.ts";

/**
 * Whether a session is a PPM Assistant session, and so runs under the Assistant's
 * instructions and permission policy rather than the mode the composer shows.
 *
 * Three sources, any one of which is enough, because losing the answer is the dangerous
 * direction — an Assistant session read as ordinary falls back to the provider default,
 * usually bypass:
 *  - the mark on the id itself, written when the session was created, forked or migrated;
 *  - the mark on the id a provider moved the session to (`resolveMigratedSession`), for a
 *    caller still holding Codex's draft id after the first turn renamed it;
 *  - the session's working directory being the Assistant's, which nothing but an Assistant
 *    session runs in — the fallback for a row that lost its mark or never got one (a session
 *    resumed after its metadata was deleted, a provider writing its own row first).
 *
 * `cwd` is the live session's working directory when the caller has one in memory; the stored
 * project path is consulted either way.
 */
export function isAssistantSession(sessionId: string, cwd?: string | null): boolean {
  if (getSessionIsAssistant(sessionId)) return true;
  const migrated = resolveMigratedSession(sessionId);
  if (migrated !== sessionId && getSessionIsAssistant(migrated)) return true;
  return isAssistantWorkDir(cwd) || isAssistantWorkDir(getSessionProjectPath(sessionId))
    || (migrated !== sessionId && isAssistantWorkDir(getSessionProjectPath(migrated)));
}

/** True when the path is the Assistant's work directory. Case-folded where the filesystem is. */
export function isAssistantWorkDir(path: string | null | undefined): boolean {
  if (!path) return false;
  const fold = (p: string) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);
  return fold(resolve(path)) === fold(assistantWorkDir());
}
