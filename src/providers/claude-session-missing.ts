/**
 * When Claude Code no longer has a conversation PPM asks it to resume.
 *
 * The CLI answers `--resume <id>` for a transcript it cannot find with one result before anything
 * else — `error_during_execution`, no turns, `errors: ["No conversation found with session ID: …"]`
 * — and exits 1 (verified against CLI 2.1.322 in an empty config dir, before any sign-in check).
 * Signing out does NOT cause it: a signed-out CLI still writes and resumes its transcripts. It is
 * the transcript itself that is gone (see `resume-handoff.ts`), so resuming again can never work.
 *
 * What happens instead depends on `ai.resume_recovery` (on unless switched off in Settings → AI
 * Provider): on, a new Claude session under the same id carries the history PPM kept; off — or with
 * no history to carry — the turn stops with {@link SESSION_MISSING_SUBTYPE}, the next message starts
 * a new session, and the chat's note offers that or a new chat.
 */
import { sessionMissingMessage } from "../shared/turn-stop.ts";

export { sessionMissingMessage };

/** The `done` subtype the stop bar draws as "gone from Claude Code" rather than as an error. */
export const SESSION_MISSING_SUBTYPE = "error_session_missing" as const;

const NO_CONVERSATION_RE = /^No conversation found with session ID\b/i;

/** The CLI's own refusal to resume a transcript it does not have. */
export function isSessionMissingResult(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { type?: unknown; subtype?: unknown; num_turns?: unknown; errors?: unknown };
  if (m.type !== "result" || m.subtype !== "error_during_execution") return false;
  if (typeof m.num_turns === "number" && m.num_turns > 0) return false;
  return Array.isArray(m.errors) && m.errors.some((e) => typeof e === "string" && NO_CONVERSATION_RE.test(e.trim()));
}

/** Carry the kept history into a new session: on unless switched off. */
export function resumeRecoveryOn(ai: { resume_recovery?: boolean } | undefined): boolean {
  return ai?.resume_recovery !== false;
}

/** The CLI asking for its own sign-in: "Not logged in · Please run /login" (CLI 2.1.322, empty config dir). */
export function isCliSignInRequest(cliText: string): boolean {
  return /not logged in|please run \/login/i.test(cliText);
}

/**
 * A signed-out Claude CLI, in the mode where PPM uses the CLI's own sign-in (no PPM account).
 * "Settings → Accounts" alone pointed at an empty list; the CLI's own words say what happened.
 */
export function cliSignedOutMessage(cliText: string): string {
  const said = cliText.trim().replace(/\s+/g, " ").slice(0, 200);
  return "Claude Code on this computer is signed out.\n"
    + (said ? `Claude said: “${said}”. ` : "")
    + "Add an account in Settings → Accounts, or run `claude auth login` on the computer running PPM, then press Continue.";
}

/**
 * The text the SDK remembers from an error result, built the way the SDK 0.3.322 builds it
 * (`Query.readMessages`): an error subtype's `errors` trimmed and joined with "; ", or a
 * `success` result's own text when it is flagged `is_error`. Undefined for a result that is no error.
 */
export function resultErrorText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as { is_error?: unknown; subtype?: unknown; result?: unknown; errors?: unknown };
  if (r.is_error !== true) return undefined;
  if (r.subtype === "success") return typeof r.result === "string" && r.result ? r.result : undefined;
  const errors = Array.isArray(r.errors) ? r.errors.filter((e): e is string => typeof e === "string") : [];
  return errors.map((e) => e.trim()).filter(Boolean).join("; ") || undefined;
}

/**
 * The SDK's own copy of a result error it already delivered: when the CLI exits after an error
 * result, the SDK replaces the exit error with `Claude Code returned an error result: <the same
 * text>`. Reporting it again showed every such failure twice.
 */
export function isEchoOfResultError(crashMessage: string, resultText: string | undefined): boolean {
  if (!resultText) return false;
  const prefix = "Claude Code returned an error result:";
  const at = crashMessage.indexOf(prefix);
  if (at < 0) return false;
  return crashMessage.slice(at + prefix.length).trim() === resultText.trim();
}
