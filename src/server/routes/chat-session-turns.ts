import { Hono, type Context } from "hono";
import { ok, err } from "../../types/api.ts";
import { getSessionTitle } from "../../services/db.service.ts";
import { getSessionTurn, listSessionTurns, resolveTurnOf, type SessionRef } from "../../services/session-turns/session-turn-index.service.ts";
import { SessionTurnError, TURN_ID_RE } from "../../services/session-turns/session-turn-types.ts";
import { createLogger } from "../../services/logger.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

const log = createLogger("session-turns");

/**
 * A chat session's turns, for turn links and the jump to a turn. Mounted under one project's
 * `/chat`, and every answer is for a session of that project only: the index reads a transcript
 * only once `assertSessionInProject` has proven it is this project's, so another project's
 * session is a 404 as if it did not exist.
 */
export const chatSessionTurnsRoutes = new Hono<Env>();

const STATUS: Record<SessionTurnError["code"], 400 | 404 | 409 | 410> = {
  invalid: 400,
  session_missing: 404,
  not_found: 404,
  rolled_back: 410,
  stale: 409,
};

function refOf(c: Context<Env>): SessionRef {
  return { providerId: c.req.query("providerId") ?? "claude", sessionId: c.req.param("id") ?? "", projectPath: c.get("projectPath") };
}

/**
 * A `SessionTurnError` carries a message written for the browser. Anything else — an fs error
 * naming the transcript's full path, say — is logged here and answered with a fixed message.
 */
function fail(c: Context<Env>, e: unknown): Response {
  if (e instanceof SessionTurnError) return c.json({ ...err(e.message), code: e.code }, STATUS[e.code]);
  log.error(`turns route failed:`, e);
  return c.json(err("Could not read the session's turns"), 500);
}

/**
 * GET /chat/sessions/:id/turns?providerId=&resolve=<message uuid>
 * Every turn of the session in order. `resolve` also names the turn one message belongs to
 * (Claude: a record uuid; Codex: a native turn id). `sessionId` is the id that owns the
 * transcript, which differs from the one asked for after a Codex migration.
 */
chatSessionTurnsRoutes.get("/sessions/:id/turns", async (c) => {
  try {
    const ref = refOf(c);
    const result = await listSessionTurns(ref);
    const key = c.req.query("resolve");
    const resolved = key && key.length <= 128 ? await resolveTurnOf(ref, { messageUuid: key }) : undefined;
    return c.json(ok({ ...result, ...(resolved !== undefined ? { resolved } : {}) }));
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * GET /chat/sessions/:id/turns/:turnId?providerId=
 * One turn's metadata, plus what to call its session — everything a turn chip shows.
 */
chatSessionTurnsRoutes.get("/sessions/:id/turns/:turnId", async (c) => {
  try {
    const turnId = c.req.param("turnId");
    if (!TURN_ID_RE.test(turnId)) throw new SessionTurnError("invalid", "Invalid turn id");
    const ref = refOf(c);
    const turn = await getSessionTurn(ref, turnId);
    // A session started outside PPM has no stored title; its first prompt is what names it.
    const title = getSessionTitle(turn.sessionId) ?? getSessionTitle(ref.sessionId)
      ?? (await listSessionTurns(ref)).turns[0]?.prompt ?? null;
    return c.json(ok({ ...turn, providerId: ref.providerId, sessionTitle: title }));
  } catch (e) {
    return fail(c, e);
  }
});
