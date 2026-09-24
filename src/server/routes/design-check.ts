import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import { CHECK_REQUEST_ID_RE, parseCanvasCheckReport } from "../../shared/design-canvas-check.ts";
import { isValidDesignSlug } from "../../services/design/design-slug.ts";
import { canvasCheckBroker } from "../../services/design/check/design-canvas-check-broker.ts";
import type { DesignRouteEnv } from "./design-route-helpers.ts";

/**
 * `POST /api/project/:projectName/designs/:slug/check/:requestId` — a browser's answer to a
 * `design:check_request`. Authenticated like every design route, and settles only a check
 * that is pending for this very project and design.
 *
 * The body was measured inside the design frame, where the page's own scripts run, so it is
 * size-capped before parsing and validated field by field; nothing in it is ever a path.
 */

/** A 400 KB screenshot as base64 plus 30 capped findings, with room to spare. */
export const MAX_CHECK_BODY_BYTES = 768 * 1024;

export const designCheckRoutes = new Hono<DesignRouteEnv>();

designCheckRoutes.post("/:requestId", async (c) => {
  const slug = c.req.param("slug") ?? "";
  const requestId = c.req.param("requestId");
  if (!isValidDesignSlug(slug) || !CHECK_REQUEST_ID_RE.test(requestId)) return c.json(err("Invalid design or request"), 400);
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_CHECK_BODY_BYTES) return c.json(err("Check report too large"), 413);
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return c.json(err("Could not read the report"), 400);
  }
  if (Buffer.byteLength(raw) > MAX_CHECK_BODY_BYTES) return c.json(err("Check report too large"), 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json(err("Expected a JSON report"), 400);
  }
  const report = parseCanvasCheckReport(body);
  if (!report) return c.json(err("Malformed check report"), 400);
  if (!canvasCheckBroker.resolveCheck(c.get("projectPath"), slug, requestId, report)) {
    // Already answered by another client, timed out, or never asked of this design.
    return c.json(err("No pending check with that id"), 404);
  }
  return c.json(ok({ accepted: true }));
});
