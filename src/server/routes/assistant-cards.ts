import { Hono, type Context } from "hono";
import { assistantCards } from "../../services/assistant-cards/assistant-cards.service.ts";
import { answerCard, dismissCard, restoreCard, type CardActionResult } from "../../services/assistant-cards/assistant-card-actions.ts";
import { chooseCardOption, okCard, replyToCard } from "../../services/assistant-cards/card-reply-actions.ts";
import type { CardActor } from "../../services/assistant-cards/forward-verbatim.ts";
import { createLogger } from "../../services/logger.ts";
import { ok, err } from "../../types/api.ts";

/**
 * PPM Assistant's cards (`/api/assistant/cards`, `/api/assistant/waiting`), behind PPM's auth.
 * The list is filtered and paged on the server; every action checks the card's kind and status
 * there, so a stale screen can only learn that the card was already answered.
 */
export const assistantCardRoutes = new Hono();

const log = createLogger("assistant-cards");
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;
const CARD_ID_RE = /^[0-9a-f-]{36}$/i;

function respond(c: Context, result: CardActionResult, action: string, id: string) {
  log.info(`card ${id} ${action}: ${result.ok ? result.card.status : `${result.status} ${result.error}`} (site=${c.req.header("sec-fetch-site") ?? "none"})`);
  if (result.ok) return c.json(ok({ card: result.card, ...(result.stale ? { stale: true } : {}) }));
  // A card answered elsewhere comes back with its state, so the screen can show who answered.
  return c.json({ ...err(result.error), ...(result.card ? { data: { card: result.card } } : {}) }, result.status);
}

assistantCardRoutes.get("/cards", (c) => {
  const beforeRaw = c.req.query("before");
  const limitRaw = c.req.query("limit");
  const project = c.req.query("project");
  const before = beforeRaw === undefined ? undefined : Number(beforeRaw);
  const limit = limitRaw === undefined ? DEFAULT_LIMIT : Number(limitRaw);
  if (before !== undefined && (!Number.isFinite(before) || before <= 0)) return c.json(err("before must be a time in ms"), 400);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return c.json(err(`limit must be 1–${MAX_LIMIT}`), 400);
  if (project !== undefined && (project.length === 0 || project.length > 200)) return c.json(err("project is a project's name"), 400);
  try {
    return c.json(ok(assistantCards.list({ ...(before !== undefined ? { before } : {}), limit, ...(project !== undefined ? { projectName: project } : {}) })));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * Every card still waiting on the user (oldest first), one project's when `project` names it: the
 * cards behind the waiting counts, which the Assistant pins above its stream and a manager chat
 * shows above its composer.
 */
assistantCardRoutes.get("/cards/open", (c) => {
  const project = c.req.query("project");
  if (project !== undefined && (project.length === 0 || project.length > 200)) return c.json(err("project is a project's name"), 400);
  try {
    return c.json(ok({ cards: assistantCards.openCards(project) }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

assistantCardRoutes.get("/waiting", (c) => {
  try {
    return c.json(ok(assistantCards.waiting()));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

assistantCardRoutes.post("/cards/:id/answer", async (c) => {
  const id = c.req.param("id");
  if (!CARD_ID_RE.test(id)) return c.json(err("No such card"), 404);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(err("Body must be JSON"), 400);
  }
  try {
    return respond(c, answerCard(id, body), "answer", id);
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The person's device and how the request reached PPM, for the session trace. */
function actorOf(c: Context, body: unknown): CardActor {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>).deviceId : undefined;
  const site = c.req.header("sec-fetch-site");
  return {
    channel: "ppm",
    ...(typeof raw === "string" && DEVICE_ID_RE.test(raw) ? { deviceId: raw } : {}),
    ...(site && /^[a-z-]{1,20}$/.test(site) ? { fetchSite: site } : {}),
  };
}

/**
 * The largest body a reply may send: five images of 5 MB as base64 (~6.7 MB each) and the words,
 * with room to spare. Refused before parsing, so an oversized body is never read into memory whole
 * when the client says up front how big it is; `replyToCard` checks each image itself either way.
 */
const MAX_REPLY_BODY_BYTES = 40 * 1024 * 1024;

/**
 * OK on a needs-decision card, a press on one of a card's choices (`{ optionId }`), or the user's
 * reply to a card (`{ text, images?, force? }`): forwarded word for word, with any images.
 */
const PRESS_ACTIONS = { ok: okCard, choose: chooseCardOption, reply: replyToCard } as const;
for (const action of ["ok", "choose", "reply"] as const) {
  assistantCardRoutes.post(`/cards/:id/${action}`, async (c) => {
    const id = c.req.param("id");
    if (!CARD_ID_RE.test(id)) return c.json(err("No such card"), 404);
    const declared = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_REPLY_BODY_BYTES) return c.json(err("The reply is too large"), 413);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(err("Body must be JSON"), 400);
    }
    try {
      const actor = actorOf(c, body);
      const result = await PRESS_ACTIONS[action](id, body, actor);
      log.info(`card ${id} ${action}: ${result.ok ? `sent to ${result.to}` : `${result.status} ${result.error}`} (site=${actor.fetchSite ?? "none"})`);
      if (result.ok) return c.json(ok({ card: result.card, to: result.to, ...(result.projectName ? { projectName: result.projectName } : {}) }));
      const data = { ...(result.card ? { card: result.card } : {}), ...(result.question ? { question: result.question } : {}) };
      return c.json({ ...err(result.error), ...(Object.keys(data).length ? { data } : {}) }, result.status);
    } catch (e) {
      return c.json(err((e as Error).message), 500);
    }
  });
}

assistantCardRoutes.post("/cards/:id/dismiss", (c) => {
  const id = c.req.param("id");
  if (!CARD_ID_RE.test(id)) return c.json(err("No such card"), 404);
  try {
    return respond(c, dismissCard(id), "dismiss", id);
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** The user bringing back a card its author withdrew (never a dismissal of their own). */
assistantCardRoutes.post("/cards/:id/restore", (c) => {
  const id = c.req.param("id");
  if (!CARD_ID_RE.test(id)) return c.json(err("No such card"), 404);
  try {
    return respond(c, restoreCard(id), "restore", id);
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});
