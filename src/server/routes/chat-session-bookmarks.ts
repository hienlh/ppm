import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { addSessionBookmark, listSessionBookmarks, removeSessionBookmark } from "../../services/session-bookmarks.service.ts";
import { TURN_ID_RE } from "../../services/session-turns/session-turn-types.ts";
import { MAX_BOOKMARK_LABEL } from "../../shared/session-bookmarks.ts";

/** A chat's bookmarked turns (`session-bookmarks.service.ts`), mounted under a project's `/chat`. */
export const chatSessionBookmarksRoutes = new Hono();

/** GET /chat/sessions/:id/bookmarks */
chatSessionBookmarksRoutes.get("/sessions/:id/bookmarks", (c) => c.json(ok(listSessionBookmarks(c.req.param("id")))));

/** PUT /chat/sessions/:id/bookmarks/:turnId { turnN?, label } — bookmark a turn, or rename one. */
chatSessionBookmarksRoutes.put("/sessions/:id/bookmarks/:turnId", async (c) => {
  const turnId = c.req.param("turnId");
  if (!TURN_ID_RE.test(turnId)) return c.json(err("Invalid turn id"), 400);
  const body = await c.req.json().catch(() => ({})) as { turnN?: unknown; label?: unknown };
  const label = typeof body.label === "string" ? body.label.trim().slice(0, MAX_BOOKMARK_LABEL) : "";
  const turnN = Number.isInteger(body.turnN) && (body.turnN as number) > 0 ? body.turnN as number : undefined;
  return c.json(ok(addSessionBookmark(c.req.param("id"), { turnId, turnN, label })));
});

/** DELETE /chat/sessions/:id/bookmarks/:turnId */
chatSessionBookmarksRoutes.delete("/sessions/:id/bookmarks/:turnId", (c) => {
  const turnId = c.req.param("turnId");
  if (!TURN_ID_RE.test(turnId)) return c.json(err("Invalid turn id"), 400);
  return c.json(ok(removeSessionBookmark(c.req.param("id"), turnId)));
});
