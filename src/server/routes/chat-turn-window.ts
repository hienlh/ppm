import { Hono, type Context } from "hono";
import { ok, err } from "../../types/api.ts";
import type { ChatMessage } from "../../types/chat.ts";
import { getSessionTurn, listSessionTurns, type SessionRef } from "../../services/session-turns/session-turn-index.service.ts";
import { readSessionTurnMessages } from "../../services/session-turns/session-turn-reader.ts";
import { SessionTurnError, TURN_ID_RE, type SessionTurnSummary } from "../../services/session-turns/session-turn-types.ts";
import { createLogger } from "../../services/logger.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

const log = createLogger("session-turns");

/**
 * A block of a session's turns read straight from the turn index, for the chat's jump to a turn
 * that is not loaded. The live history pages count messages back from the newest one, so a turn
 * 300 prompts back would mean loading everything after it; this reads only the turns around it,
 * across compactions, and the chat shows them in a container of their own.
 *
 * Mounted under one project's `/chat`: the index opens a transcript only once
 * `assertSessionInProject` has proven it belongs to this project.
 */
export const chatTurnWindowRoutes = new Hono<Env>();

/** Most turns one answer holds: the chat keeps about three answers' worth on screen. */
export const TURN_WINDOW_MAX_TURNS = 10;
/** Messages one answer aims to stay under; the turn asked for is always included whole. */
export const TURN_WINDOW_MAX_MESSAGES = 400;

const DEFAULT_BEFORE = 2;
const DEFAULT_AFTER = 3;
const DEFAULT_COUNT = 3;

export type TurnWindowQuery =
  /** The turn and some turns either side of it. */
  | { kind: "around"; turnId: string; before: number; after: number }
  /** Turns after this one, for scrolling down. */
  | { kind: "after"; turnId: string; count: number }
  /** Turns before this one, for scrolling up. */
  | { kind: "before"; turnId: string; count: number };

function count(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new SessionTurnError("invalid", "Invalid turn count");
  return Math.min(Math.max(Math.floor(n), min), TURN_WINDOW_MAX_TURNS);
}

function turnIdOf(raw: string): string {
  if (!TURN_ID_RE.test(raw)) throw new SessionTurnError("invalid", "Invalid turn id");
  return raw;
}

export function parseTurnWindowQuery(q: (name: string) => string | undefined): TurnWindowQuery {
  const turn = q("turn");
  const after = q("afterTurn");
  const before = q("beforeTurn");
  if ([turn, after, before].filter((v) => v !== undefined).length !== 1) {
    throw new SessionTurnError("invalid", "Give exactly one of turn, afterTurn or beforeTurn");
  }
  if (turn !== undefined) {
    return { kind: "around", turnId: turnIdOf(turn), before: count(q("before"), DEFAULT_BEFORE, 0), after: count(q("after"), DEFAULT_AFTER, 0) };
  }
  if (after !== undefined) return { kind: "after", turnId: turnIdOf(after), count: count(q("count"), DEFAULT_COUNT, 1) };
  return { kind: "before", turnId: turnIdOf(before!), count: count(q("count"), DEFAULT_COUNT, 1) };
}

/**
 * Which turns to read, as `[from, to)` indices into `turns`; `index` is the query's turn. Turns
 * are added one at a time, nearest first, while both caps hold. Around a turn the two sides take
 * turns, so a long turn on one side does not starve the other.
 */
export function pickWindowTurns(turns: readonly SessionTurnSummary[], index: number, query: TurnWindowQuery): { from: number; to: number } {
  let budget = TURN_WINDOW_MAX_MESSAGES;
  let room = TURN_WINDOW_MAX_TURNS;
  const fits = (i: number) => room > 0 && turns[i]!.messageCount <= budget;
  const take = (i: number) => { room--; budget -= turns[i]!.messageCount; };
  if (query.kind === "around") {
    let from = index;
    let to = index + 1;
    take(index);
    budget = Math.max(budget, 0);
    let older = query.before;
    let newer = query.after;
    while (older > 0 || newer > 0) {
      let moved = false;
      if (older > 0 && from > 0 && fits(from - 1)) { take(--from); older--; moved = true; } else older = 0;
      if (newer > 0 && to < turns.length && fits(to)) { take(to++); newer--; moved = true; } else newer = 0;
      if (!moved) break;
    }
    return { from, to };
  }
  if (query.kind === "after") {
    let to = index + 1;
    // The first turn is taken whatever its size: scrolling down must always make progress.
    while (to < turns.length && to - index - 1 < query.count && (to === index + 1 || fits(to))) take(to++);
    return { from: index + 1, to };
  }
  let from = index;
  while (from > 0 && index - from < query.count && (from === index || fits(from - 1))) take(--from);
  return { from, to: index };
}

export interface TurnWindow {
  /** The id that owns the transcript (after a Codex migration it differs from the one asked for). */
  sessionId: string;
  turns: Array<Pick<SessionTurnSummary, "turnId" | "n" | "status">>;
  /** The turns' messages in order, each stamped with its turn (a compaction marker excepted). */
  messages: ChatMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
  /** The session's newest turn, so the chat can tell when the window has reached the live list. */
  latestTurnId: string | null;
}

/**
 * A Codex message id is its position in the parse that produced it (`rollout-N`), and each turn
 * here is parsed on its own, so every turn would start again at `rollout-0`. The window draws all
 * of them in one list and finds rows by id, so each id is prefixed with its turn. The live list's
 * ids are not touched: the window's ids are its own, and nothing matches the two by id.
 */
function windowMessages(providerId: string, read: Array<{ turn: SessionTurnSummary; messages: ChatMessage[] }>): ChatMessage[] {
  if (providerId !== "codex") return read.flatMap((r) => r.messages);
  return read.flatMap(({ turn, messages }) => messages.map((m) => ({ ...m, id: `${turn.turnId}:${m.id}` })));
}

export async function readTurnWindow(ref: SessionRef, query: TurnWindowQuery): Promise<TurnWindow> {
  const { sessionId, turns } = await listSessionTurns(ref);
  const index = turns.findIndex((t) => t.turnId === query.turnId);
  if (index === -1) {
    // Throws `rolled_back` or `not_found`, whichever it is.
    await getSessionTurn(ref, query.turnId);
    throw new SessionTurnError("not_found", "No such turn in this session");
  }
  const { from, to } = pickWindowTurns(turns, index, query);
  const picked = turns.slice(from, to);
  const read = picked.length > 0 ? await readSessionTurnMessages(ref, picked.map((t) => t.turnId)) : [];
  return {
    sessionId,
    turns: read.map(({ turn }) => ({ turnId: turn.turnId, n: turn.n, status: turn.status })),
    messages: windowMessages(ref.providerId, read),
    hasOlder: from > 0,
    hasNewer: to < turns.length,
    latestTurnId: turns[turns.length - 1]?.turnId ?? null,
  };
}

const STATUS: Record<SessionTurnError["code"], 400 | 404 | 409 | 410> = {
  invalid: 400,
  session_missing: 404,
  not_found: 404,
  rolled_back: 410,
  stale: 409,
};

function fail(c: Context<Env>, e: unknown): Response {
  if (e instanceof SessionTurnError) return c.json({ ...err(e.message), code: e.code }, STATUS[e.code]);
  log.error(`turn window failed:`, e);
  return c.json(err("Could not read the session's turns"), 500);
}

/**
 * GET /chat/sessions/:id/turn-window?providerId=
 *   &turn=<turnId>&before=<k>&after=<k>   a turn and its neighbours (defaults 2 and 3)
 *   &afterTurn=<turnId>&count=<k>         the turns after one (default 3)
 *   &beforeTurn=<turnId>&count=<k>        the turns before one (default 3)
 */
chatTurnWindowRoutes.get("/sessions/:id/turn-window", async (c) => {
  try {
    const query = parseTurnWindowQuery((name) => c.req.query(name));
    const ref: SessionRef = { providerId: c.req.query("providerId") ?? "claude", sessionId: c.req.param("id") ?? "", projectPath: c.get("projectPath") };
    return c.json(ok(await readTurnWindow(ref, query)));
  } catch (e) {
    return fail(c, e);
  }
});
