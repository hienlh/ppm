import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ok, err } from "../../types/api.ts";
import { isDesignError } from "../../services/design/design-error.ts";
import {
  createShareLink, deleteShareLink, listShareLinks, previewShareRepin, updateShareLink,
} from "../../services/design/share/design-share-links.service.ts";
import { deleteThreadsOfLink } from "../../services/design/design-comment-replies.service.ts";
import { designFail, designJsonBody as jsonBody, type DesignRouteEnv } from "./design-route-helpers.ts";

/**
 * `/api/project/:projectName/designs/:slug/shares` — the owner's share links of one design.
 *
 * Responses carry each link's `path` (`/s/<code>`), re-derived on every read; the stored
 * hash never leaves the server. A refusal the share service decided carries a `code`
 * beside the message (`signin-off`, `limit`, `revoked`…) so the dialog can say what to do.
 */

export const designShareRoutes = new Hono<DesignRouteEnv>();

function fail(c: Context<DesignRouteEnv>, e: unknown): Response {
  if (isDesignError(e) && e.status < 500) {
    return c.json({ ...err(e.message), code: e.code }, e.status as ContentfulStatusCode);
  }
  return designFail(c, e);
}

const slugOf = (c: Context<DesignRouteEnv>) => c.req.param("slug") ?? "";

designShareRoutes.get("/", async (c) => {
  try {
    return c.json(ok({ links: await listShareLinks(c.get("projectPath"), slugOf(c)) }));
  } catch (e) {
    return fail(c, e);
  }
});

designShareRoutes.post("/", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json(err("Expected a JSON object"), 400);
  try {
    return c.json(ok({ link: await createShareLink(c.get("projectPath"), slugOf(c), body) }), 201);
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * What "Update to latest" would change for this link's reviewers, before it is done:
 * `{ changedFiles }`, the pinned snapshot against the live files, or null when the pinned
 * snapshot is gone.
 */
designShareRoutes.get("/:id/changes", async (c) => {
  try {
    return c.json(ok({ changedFiles: await previewShareRepin(c.get("projectPath"), slugOf(c), c.req.param("id")) }));
  } catch (e) {
    return fail(c, e);
  }
});

designShareRoutes.patch("/:id", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json(err("Expected a JSON object"), 400);
  try {
    return c.json(ok(await updateShareLink(c.get("projectPath"), slugOf(c), c.req.param("id"), body)));
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * Every comment thread reviewers on this link started, replies included. Answers how many
 * went. Accepted for a link whose row is already deleted: its threads outlive it.
 */
designShareRoutes.delete("/:id/comments", async (c) => {
  try {
    return c.json(ok({ deleted: await deleteThreadsOfLink(c.get("projectPath"), slugOf(c), c.req.param("id")) }));
  } catch (e) {
    return fail(c, e);
  }
});

designShareRoutes.delete("/:id", (c) => {
  try {
    deleteShareLink(c.get("projectPath"), slugOf(c), c.req.param("id"));
    return c.json(ok({ deleted: c.req.param("id") }));
  } catch (e) {
    return fail(c, e);
  }
});
