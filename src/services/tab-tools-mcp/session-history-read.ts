/**
 * `read_session_turns`'s read and answer: every turn asked for comes back, or says per id why not
 * (`not_found`, `rolled_back`, `not_permitted`, …), so one missing turn never hides the others.
 */
import { getSessionTurn, type SessionRef } from "../session-turns/session-turn-index.service.ts";
import { readSessionTurnMessages, type TurnMessages } from "../session-turns/session-turn-reader.ts";
import { SessionTurnError } from "../session-turns/session-turn-types.ts";
import type { TurnAccessCode, TurnTarget } from "../session-turns/turn-access.ts";
import { renderTurns } from "../session-turns/turn-render.ts";

export interface TurnReadError {
  turnId: string;
  code: TurnAccessCode;
}

/** Codes that belong to one turn rather than to the whole session. */
const PER_TURN = new Set(["not_found", "rolled_back"]);

const ERROR_TEXT: Record<TurnAccessCode, string> = {
  not_found: "no such turn in this session",
  rolled_back: "the turn was rolled back and is no longer part of the session",
  session_missing: "the session's transcript is not in that project, or no longer on disk",
  stale: "the transcript changed while it was being read; read it again",
  invalid: "not a valid turn id",
  not_permitted: "the user has not sent a link to this turn in this chat, and it is in another project",
};

/** Reads the turns that exist; every other id is reported with its own code. */
export async function readTurnsReportingErrors(ref: SessionRef, turnIds: string[]): Promise<{ turns: TurnMessages[]; errors: TurnReadError[] }> {
  const errors: TurnReadError[] = [];
  const present: string[] = [];
  for (const turnId of turnIds) {
    try {
      await getSessionTurn(ref, turnId);
      present.push(turnId);
    } catch (e) {
      if (!(e instanceof SessionTurnError) || !PER_TURN.has(e.code)) throw e;
      errors.push({ turnId, code: e.code });
    }
  }
  if (!present.length) return { turns: [], errors };
  try {
    return { turns: await readSessionTurnMessages(ref, present), errors };
  } catch (e) {
    if (!(e instanceof SessionTurnError) || !PER_TURN.has(e.code)) throw e;
  }
  // A turn went away between the check and the read: read the rest one by one.
  const turns: TurnMessages[] = [];
  for (const turnId of present) {
    try {
      turns.push(...await readSessionTurnMessages(ref, [turnId]));
    } catch (e) {
      if (!(e instanceof SessionTurnError) || !PER_TURN.has(e.code)) throw e;
      errors.push({ turnId, code: e.code });
    }
  }
  return { turns, errors };
}

/**
 * The tool's answer: the turns in a fence, then one line per turn that could not be read.
 * `readerProject` is the calling chat's project ("" when it has none).
 */
export function renderReadAnswer(target: TurnTarget, turns: TurnMessages[], errors: TurnReadError[], readerProject: string): string {
  const parts: string[] = [];
  if (turns.length) {
    parts.push(renderTurns({ sessionId: target.sessionId, providerId: target.providerId, projectName: target.projectName, readerProject }, turns));
  }
  for (const { turnId, code } of errors) parts.push(`Turn ${turnId}: ${code} — ${ERROR_TEXT[code]}.`);
  return parts.join("\n");
}
