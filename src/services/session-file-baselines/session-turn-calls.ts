import { sessionTurns } from "../../shared/session-turns.ts";
import { sessionFileWrites } from "../../web/lib/aggregate-turn-file-changes.ts";
import type { ChatMessage } from "../../types/chat.ts";

/**
 * A session's turns with the calls each one made, for reverting a turn from outside the browser:
 * the Assistant's review tools and `ppm chat turns` / `ppm chat revert-turn`. The grouping is the
 * browser's own (`src/shared/session-turns.ts`), run over the history PPM's chat tab loads, so a
 * turn's number here is the number the chat and the Review tab show for it.
 *
 * Only the newest `limit` turns are answered; an older turn cannot be named from here, and the
 * answer's `total` says how many there are. `paths` are the files the session's tool calls name,
 * which the change list needs for a session older than the copies PPM keeps.
 *
 * Pure, so the Assistant's tools can use it without loading the chat history reader; the read
 * itself is `session-turn-calls-read.ts`.
 */

export const DEFAULT_TURN_LIMIT = 20;
export const MAX_TURN_LIMIT = 50;
const PROMPT_CHARS = 200;

export interface TurnWithCalls {
  n: number;
  /** The server could not number the history; `n` only counts the turns loaded. */
  unnumbered?: boolean;
  at: string;
  /** The first 200 characters of what the user typed. */
  prompt: string;
  calls: string[];
}

export interface SessionTurnCalls {
  /** The newest turns, oldest first. */
  turns: TurnWithCalls[];
  /** Every turn of the session, the ones left out included. */
  total: number;
  paths: string[];
}

/** The newest `limit` turns of `messages` with their calls, and the files their calls name. Pure. */
export function summarizeTurns(messages: readonly ChatMessage[], limit: number, fromStart = true): SessionTurnCalls {
  const all = sessionTurns(messages, { fromStart });
  const turns = all.slice(Math.max(0, all.length - limit)).map((t) => ({
    n: t.n,
    ...(t.unnumbered ? { unnumbered: true } : {}),
    at: t.at,
    prompt: t.prompt.length > PROMPT_CHARS ? `${t.prompt.slice(0, PROMPT_CHARS)}…` : t.prompt,
    calls: t.calls,
  }));
  return { turns, total: all.length, paths: sessionFileWrites([...messages]).paths };
}

/** The limit a caller asked for, within bounds; the default when absent or malformed. */
export function turnLimitOf(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_TURN_LIMIT) : DEFAULT_TURN_LIMIT;
}

/** Turn `n` among `turns`, or why it cannot be named. */
export function findTurn(result: SessionTurnCalls, n: number): TurnWithCalls | string {
  const turn = result.turns.find((t) => t.n === n && !t.unnumbered);
  if (turn) return turn;
  const oldest = result.turns[0];
  if (oldest && !oldest.unnumbered && n >= 1 && n < oldest.n) {
    return `Turn ${n} is older than the newest ${result.turns.length} turns this can reach (turns ${oldest.n}–${result.turns.at(-1)!.n}); revert it from the chat's Review tab.`;
  }
  if (result.turns.some((t) => t.unnumbered)) return "PPM could not number this session's turns; revert from the chat's Review tab.";
  return `The session has no turn ${n}; its turns are ${oldest ? `${oldest.n}–${result.turns.at(-1)!.n}` : "none yet"}.`;
}
