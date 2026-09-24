import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { isDesignError } from "../../services/design/design-error.ts";
import { undoEdit } from "../../services/design/design-edit-undo-journal.ts";
import { designFail as fail, designJsonBody as jsonBody, type DesignRouteEnv } from "./design-route-helpers.ts";

/**
 * `/api/project/:projectName/designs/:slug/undo` — reverse one canvas write.
 *
 * `POST {undoId}` answers `{gen, gens}`; 404 for an id the server does not know (unknown,
 * evicted, or lost with a restart), and 409 with `data.reason: "cannot-undo"` when the text
 * the write left has changed since. The body carries the id only: what gets written back
 * comes from the server's own journal.
 */

export const designUndoRoutes = new Hono<DesignRouteEnv>();

designUndoRoutes.post("/", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json(err("Expected a JSON object"), 400);
  try {
    return c.json(ok(await undoEdit(c.get("projectPath"), c.req.param("slug") ?? "", body.undoId)));
  } catch (e) {
    if (isDesignError(e) && e.status === 409) return c.json({ ...err(e.message), data: { reason: e.code } }, 409);
    return fail(c, e);
  }
});
