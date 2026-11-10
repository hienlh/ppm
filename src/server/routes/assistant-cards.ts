import { Hono, type Context } from "hono";
import { assistantCards } from "../../services/assistant-cards/assistant-cards.service.ts";
import { answerCard, dismissCard, type CardActionResult } from "../../services/assistant-cards/assistant-card-actions.ts";
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

assistantCardRoutes.post("/cards/:id/dismiss", (c) => {
  const id = c.req.param("id");
  if (!CARD_ID_RE.test(id)) return c.json(err("No such card"), 404);
  try {
    return respond(c, dismissCard(id), "dismiss", id);
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});
