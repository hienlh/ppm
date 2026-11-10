import { Hono, type Context } from "hono";
import { assistantCards } from "../../services/assistant-cards/assistant-cards.service.ts";
import { answerCard, dismissCard, type CardActionResult } from "../../services/assistant-cards/assistant-card-actions.ts";
import { okCard, replyToCard } from "../../services/assistant-cards/card-reply-actions.ts";
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

/** OK on a needs-decision card, or the user's reply to a card: forwarded word for word. */
for (const action of ["ok", "reply"] as const) {
  assistantCardRoutes.post(`/cards/:id/${action}`, async (c) => {
    const id = c.req.param("id");
    if (!CARD_ID_RE.test(id)) return c.json(err("No such card"), 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(err("Body must be JSON"), 400);
    }
    try {
      const actor = actorOf(c, body);
      const result = action === "ok" ? await okCard(id, body, actor) : await replyToCard(id, body, actor);
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
