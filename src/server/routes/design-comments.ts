import { Hono } from "hono";
import { ok, err } from "../../types/api.ts";
import {
  addComment, deleteComment, listComments, previewElementContext, updateComment,
} from "../../services/design/design-comments.service.ts";
import { designFail as fail, designJsonBody as jsonBody, type DesignRouteEnv } from "./design-route-helpers.ts";

/**
 * `/api/project/:projectName/designs/:slug/comments` — pinned element comments.
 *
 * `POST /context` answers with the server-built snippet for one element without saving
 * anything, for "Send to AI" on a single element: the prompt must never carry markup the
 * page reported about itself.
 */

export const designCommentRoutes = new Hono<DesignRouteEnv>();

designCommentRoutes.get("/", async (c) => {
  try {
    return c.json(ok(await listComments(c.get("projectPath"), c.req.param("slug") ?? "")));
  } catch (e) {
    return fail(c, e);
  }
});

designCommentRoutes.post("/", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json(err("Expected a JSON object"), 400);
  try {
    return c.json(ok(await addComment(c.get("projectPath"), c.req.param("slug") ?? "", body)), 201);
  } catch (e) {
    return fail(c, e);
  }
});

designCommentRoutes.post("/context", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json(err("Expected a JSON object"), 400);
  try {
    return c.json(ok(await previewElementContext(c.get("projectPath"), c.req.param("slug") ?? "", body)));
  } catch (e) {
    return fail(c, e);
  }
});

designCommentRoutes.patch("/:id", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json(err("Expected a JSON object"), 400);
  try {
    return c.json(ok(await updateComment(c.get("projectPath"), c.req.param("slug") ?? "", c.req.param("id"), body)));
  } catch (e) {
    return fail(c, e);
  }
});

designCommentRoutes.delete("/:id", async (c) => {
  try {
    await deleteComment(c.get("projectPath"), c.req.param("slug") ?? "", c.req.param("id"));
    return c.json(ok({ deleted: c.req.param("id") }));
  } catch (e) {
    return fail(c, e);
  }
});
