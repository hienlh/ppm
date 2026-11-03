/**
 * Which session, and which of its turns, a chat's AI may read with the session-history tools.
 *
 * Its own project: any session the project owns (proven by `assertSessionInProject`, through
 * `resolveSessionTranscript`), any turn, by id or by a range of numbers.
 *
 * Another project: only turns the person sent links to from a browser, recorded in the grant
 * ledger for this chat session — exact ids, never a range. The transcript is then looked up in the
 * ledger project's *configured* folder, so a grant for a turn of project A can never be stretched
 * into a session of project B that happens to share the id.
 */
import { resolve } from "node:path";
import { configService } from "../config.service.ts";
import { getSessionProvider } from "../db.service.ts";
import { SESSION_ID_RE, TURN_ID_RE } from "../../shared/session-turn-ids.ts";
import { resolveSessionTranscript, type SessionRef } from "./session-turn-index.service.ts";
import { SessionTurnError, type SessionTurnErrorCode, type TurnProviderId } from "./session-turn-types.ts";
import { findTurnGrant, turnGrantsFor } from "./turn-grant-ledger.ts";

export type TurnAccessCode = SessionTurnErrorCode | "not_permitted";

/** The chat asking: its canonical session id and its own project. */
export interface TurnCaller {
  sessionId: string;
  projectPath: string | null;
  projectName: string | null;
}

/** A session the caller may read, pinned to the project it was proven in. */
export interface TurnTarget {
  ref: SessionRef;
  providerId: TurnProviderId;
  sessionId: string;
  projectName: string;
  crossProject: boolean;
}

export type TurnAccessOutcome =
  | { ok: true; target: TurnTarget; turnIds: string[]; denied: Array<{ turnId: string; code: TurnAccessCode }> }
  | { ok: false; code: TurnAccessCode; message: string };

const fail = (code: TurnAccessCode, message: string): TurnAccessOutcome => ({ ok: false, code, message });

/** A configured project's folder, by name. */
function projectPathOf(name: string): string | null {
  const project = configService.get("projects").find((p) => p.name === name);
  return project ? resolve(project.path) : null;
}

/**
 * The session in the caller's own project: the provider PPM recorded for it first, then each
 * provider in turn. Throws `SessionTurnError` (`session_missing`, `invalid`).
 */
export function resolveOwnSession(caller: TurnCaller, sessionId: string): TurnTarget {
  if (!caller.projectPath) throw new SessionTurnError("session_missing", "This chat has no project");
  const recorded = getSessionProvider(sessionId);
  const order = (recorded === "claude" || recorded === "codex" ? [recorded] : []).concat(["claude", "codex"]);
  let last: unknown = null;
  for (const providerId of [...new Set(order)]) {
    const ref: SessionRef = { providerId, sessionId, projectPath: caller.projectPath };
    try {
      const session = resolveSessionTranscript(ref);
      return { ref, providerId: session.providerId, sessionId: session.sessionId, projectName: caller.projectName ?? "", crossProject: false };
    } catch (e) {
      if (!(e instanceof SessionTurnError)) throw e;
      last = e;
    }
  }
  throw last instanceof SessionTurnError ? last : new SessionTurnError("session_missing", "Session not found in this project");
}

/** A turn id, by number range or by list, checked; the list form is the only one across projects. */
export interface TurnSelection {
  turnIds?: string[];
  range?: { from: number; to: number };
}

/**
 * What `read_session_turns` may read. `project` is the project the AI named, if any; with none, a
 * session the caller's project does not own is looked up in the ledger instead.
 */
export function resolveTurnAccess(caller: TurnCaller, sessionId: string, project: string | undefined, selection: TurnSelection): TurnAccessOutcome {
  if (!SESSION_ID_RE.test(sessionId)) return fail("invalid", "Invalid session id");
  for (const id of selection.turnIds ?? []) if (!TURN_ID_RE.test(id)) return fail("invalid", `Invalid turn id: ${id.slice(0, 80)}`);
  const own = !project || project === caller.projectName;
  if (own) {
    try {
      return { ok: true, target: resolveOwnSession(caller, sessionId), turnIds: selection.turnIds ?? [], denied: [] };
    } catch (e) {
      if (!(e instanceof SessionTurnError)) throw e;
      // A session of another project the person linked to: the AI need not name the project.
      if (project || e.code !== "session_missing" || !turnGrantsFor(caller.sessionId).some((g) => g.sessionId === sessionId)) {
        return fail(e.code, e.message);
      }
    }
  }
  return crossProjectAccess(caller, sessionId, project && !own ? project : undefined, selection);
}

function crossProjectAccess(caller: TurnCaller, sessionId: string, project: string | undefined, selection: TurnSelection): TurnAccessOutcome {
  if (selection.range || !selection.turnIds?.length) {
    return fail("not_permitted", "In another project only the exact turns the user sent links to can be read: pass their turn_ids, not a range.");
  }
  const denied: Array<{ turnId: string; code: TurnAccessCode }> = [];
  const allowed: string[] = [];
  let pinned: { projectName: string; providerId: TurnProviderId } | null = null;
  for (const turnId of selection.turnIds) {
    const grant = findTurnGrant(caller.sessionId, { projectName: project, sessionId, turnId });
    // One call reads one session in one project; a grant naming another is not this read's.
    if (!grant || (pinned && (grant.projectName !== pinned.projectName || grant.providerId !== pinned.providerId))) {
      denied.push({ turnId, code: "not_permitted" });
      continue;
    }
    pinned ??= { projectName: grant.projectName, providerId: grant.providerId };
    allowed.push(turnId);
  }
  if (!pinned) {
    return fail("not_permitted", "Those turns are in another project and the user has not sent links to them in this chat.");
  }
  const projectPath = projectPathOf(pinned.projectName);
  if (!projectPath) return fail("not_permitted", `Project ${pinned.projectName} is no longer configured in PPM.`);
  const ref: SessionRef = { providerId: pinned.providerId, sessionId, projectPath };
  try {
    const session = resolveSessionTranscript(ref);
    return {
      ok: true, turnIds: allowed, denied,
      target: { ref, providerId: session.providerId, sessionId: session.sessionId, projectName: pinned.projectName, crossProject: true },
    };
  } catch (e) {
    if (e instanceof SessionTurnError) return fail(e.code, e.message);
    throw e;
  }
}
