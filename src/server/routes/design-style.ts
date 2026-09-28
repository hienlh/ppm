import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { StyleConflictError, commitStylePatch } from "../../services/design/design-style-patch.service.ts";
import { designFail as fail, designJsonBody as jsonBody, type DesignRouteEnv } from "./design-route-helpers.ts";

/**
 * `/api/project/:projectName/designs/:slug/style` — a move or resize from the canvas.
 *
 * `POST {file, gen, ppmId, tag, props}` answers `{gen, undoId}`. A 409 says why in
 * `data.reason` — `stale` (the file changed since the canvas loaded it) or `element-moved`
 * (no element with that tag at that position) — with the file's current gen; a 429 means the
 * design's canvas write limit was hit.
 */

export const designStyleRoutes = new Hono<DesignRouteEnv>();

designStyleRoutes.post("/", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json(err("Expected a JSON object"), 400);
  try {
    return c.json(ok(await commitStylePatch(c.get("projectPath"), c.req.param("slug") ?? "", body)));
  } catch (e) {
    if (e instanceof StyleConflictError) {
      return c.json({ ...err(e.message), data: { reason: e.code, currentGen: e.currentGen } }, 409);
    }
    return fail(c, e);
  }
});
