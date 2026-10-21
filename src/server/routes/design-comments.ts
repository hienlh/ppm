import { Hono, type Context } from "hono";
import { ok, err } from "../../types/api.ts";
import type { StoredDesignComment } from "../../shared/design-comment-thread-types.ts";
import {
  addComment, deleteComment, listComments, previewElementContext, updateComment,
} from "../../services/design/design-comments.service.ts";
import { addReply, deleteReply, updateReply } from "../../services/design/design-comment-replies.service.ts";
import { toOwnerView } from "../../services/design/comments/design-comment-views.ts";
import { listShareLinksForDesign } from "../../services/design/share/design-share-links-store.ts";
import { projectKey } from "../../services/project-name-for-path.ts";
import { designFail as fail, designJsonBody as jsonBody, type DesignRouteEnv } from "./design-route-helpers.ts";

/**
 * `/api/project/:projectName/designs/:slug/comments` — pinned element comments and their
 * replies, as the owner sees them (`DesignCommentOwnerView`): every author named, each
 * reviewer's link by its label, and no reviewer's key hash.
 *
 * `POST /context` answers with the server-built snippet for one element without saving
 * anything, for "Send to AI" on a single element: the prompt must never carry markup the
 * page reported about itself.
 */

export const designCommentRoutes = new Hono<DesignRouteEnv>();

const slugOf = (c: Context<DesignRouteEnv>) => c.req.param("slug") ?? "";

/** Labels of the design's share links by id, read once per response. */
function linkLabels(c: Context<DesignRouteEnv>): Map<string, string> {
  return new Map(listShareLinksForDesign(projectKey(c.get("projectPath")), slugOf(c)).map((l) => [l.id, l.label]));
}

const ownerView = (c: Context<DesignRouteEnv>, comment: StoredDesignComment) => toOwnerView(comment, linkLabels(c));

designCommentRoutes.get("/", async (c) => {
  try {
    const comments = await listComments(c.get("projectPath"), slugOf(c));
    const labels = linkLabels(c);
    return c.json(ok(comments.map((comment) => toOwnerView(comment, labels))));
  } catch (e) {
    return fail(c, e);
  }
});

designCommentRoutes.post("/", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json(err("Expected a JSON object"), 400);
  try {
    return c.json(ok(ownerView(c, await addComment(c.get("projectPath"), slugOf(c), body))), 201);
  } catch (e) {
    return fail(c, e);
  }
});

designCommentRoutes.post("/context", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json(err("Expected a JSON object"), 400);
  try {
    return c.json(ok(await previewElementContext(c.get("projectPath"), slugOf(c), body)));
  } catch (e) {
    return fail(c, e);
  }
});

designCommentRoutes.patch("/:id", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json(err("Expected a JSON object"), 400);
  try {
    return c.json(ok(ownerView(c, await updateComment(c.get("projectPath"), slugOf(c), c.req.param("id"), body))));
  } catch (e) {
    return fail(c, e);
  }
});

designCommentRoutes.delete("/:id", async (c) => {
  try {
    await deleteComment(c.get("projectPath"), slugOf(c), c.req.param("id"));
    return c.json(ok({ deleted: c.req.param("id") }));
  } catch (e) {
    return fail(c, e);
  }
});

/** Replies answer with the whole thread, so the canvas can replace it in one step. */
designCommentRoutes.post("/:id/replies", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json(err("Expected a JSON object"), 400);
  try {
    const { thread } = await addReply(c.get("projectPath"), slugOf(c), c.req.param("id"), body);
    return c.json(ok(ownerView(c, thread)), 201);
  } catch (e) {
    return fail(c, e);
  }
});

designCommentRoutes.patch("/:id/replies/:replyId", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json(err("Expected a JSON object"), 400);
  try {
    const { thread } = await updateReply(c.get("projectPath"), slugOf(c), c.req.param("id"), c.req.param("replyId"), body);
    return c.json(ok(ownerView(c, thread)));
  } catch (e) {
    return fail(c, e);
  }
});

designCommentRoutes.delete("/:id/replies/:replyId", async (c) => {
  try {
    return c.json(ok(ownerView(c, await deleteReply(c.get("projectPath"), slugOf(c), c.req.param("id"), c.req.param("replyId")))));
  } catch (e) {
    return fail(c, e);
  }
});
