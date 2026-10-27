/**
 * Where a chat session's processes live, by name. Every command a chat's Claude CLI runs goes
 * into a scope under one systemd slice per session, `app-ppmchat-<instance>-<session>.slice`, so
 * what the chat left running can be found and stopped long after the command that started it.
 *
 * A '-' in a slice name is a level of the tree: all of one PPM's sessions sit under
 * `app-ppmchat-<instance>.slice`, inside `app.slice`. The instance is named after the database
 * because dev and prod share ~/.ppm, and one PPM must never judge another's sessions idle.
 */
import { createHash } from "node:crypto";

/** What the CLI's commands read to know their session's slice. */
export const SLICE_ENV = "PPM_CHAT_SLICE";
/** Directory, under the PPM dir's `bin/`, holding the two scripts; how an inherited copy is recognised. */
export const SESSION_SHELL_DIR = "chat-session-shell";
/** Name prefix of the scope every command runs in, as opposed to a unit the agent made itself. */
export const COMMAND_SCOPE_PREFIX = "ppmcmd-";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function instanceTag(dbPath: string): string {
  return createHash("sha256").update(dbPath).digest("hex").slice(0, 8);
}

export function instanceSliceName(instance: string): string {
  return `app-ppmchat-${instance}.slice`;
}

/** Null for an id that is not a lowercase UUID: it could not be read back from the name. */
export function sessionSliceName(instance: string, sessionId: string): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  return `app-ppmchat-${instance}-${sessionId.replace(/-/g, "")}.slice`;
}

export function sessionIdOfSlice(instance: string, sliceName: string): string | null {
  const prefix = `app-ppmchat-${instance}-`;
  if (!sliceName.startsWith(prefix) || !sliceName.endsWith(".slice")) return null;
  const hex = sliceName.slice(prefix.length, -".slice".length);
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The PPM session a CLI is spawned for. A fork's first CLI resumes its source under an id the
 * CLI picks itself, so it is left untracked rather than filed under the session it came from.
 */
export function chatSessionIdOf(options: { sessionId?: string; resume?: string; forkSession?: boolean } | undefined): string | undefined {
  if (!options) return undefined;
  return options.sessionId ?? (options.forkSession ? undefined : options.resume);
}

export interface SessionShell {
  /** The `CLAUDE_CODE_SHELL_PREFIX` script. */
  prefix: string;
  /** Directory put first on the CLI's PATH, holding the `systemd-run` shim. */
  pathDir: string;
}

const isOurs = (path: string) => path.includes(`/${SESSION_SHELL_DIR}/`);

/**
 * The CLI's environment with its commands routed into `slice`, or with no routing at all when
 * `slice` is null. Either way an inherited routing is dropped first: a PPM started from inside
 * a chat would otherwise file its own sessions' commands under that chat.
 */
export function withSessionSlice(
  env: Record<string, string | undefined>,
  slice: string | null,
  shell: SessionShell | null,
): Record<string, string | undefined> {
  const out = { ...env };
  delete out[SLICE_ENV];
  if (out.CLAUDE_CODE_SHELL_PREFIX && isOurs(out.CLAUDE_CODE_SHELL_PREFIX)) delete out.CLAUDE_CODE_SHELL_PREFIX;
  if (out.PATH === undefined) return out;
  const path = out.PATH.split(":").filter((dir) => dir && !isOurs(`${dir}/`));
  out.PATH = path.join(":");
  // The CLI splits a prefix at its last " -" into program and flags, so such a path cannot be
  // passed at all. A prefix of the user's own wins, and the session goes untracked.
  if (!slice || !shell || shell.prefix.includes(" -") || out.CLAUDE_CODE_SHELL_PREFIX) return out;
  out[SLICE_ENV] = slice;
  out.CLAUDE_CODE_SHELL_PREFIX = shell.prefix;
  out.PATH = [shell.pathDir, ...path].join(":");
  return out;
}
