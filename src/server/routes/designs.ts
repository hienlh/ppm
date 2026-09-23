import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ok, err } from "../../types/api.ts";
import { mapFsError } from "../../services/fs-path-guard.service.ts";
import { isSnapshotId } from "../../shared/design-types.ts";
import {
  createDesign, deleteDesign, designSystemStatus, getDesign, listDesigns, renameDesign,
} from "../../services/design/design-store.service.ts";
import { listSnapshots } from "../../services/design/design-snapshots.service.ts";
import { restoreSnapshot } from "../../services/design/design-restore.service.ts";

/**
 * `/api/project/:projectName/designs` — the design folders of one project.
 *
 * Every path is derived from the server-side project path plus a validated slug; nothing
 * the client sends is used as a path. Later features mount their own sub-routes on this
 * router (comments, tweaks, write-backs, exports) by appending below.
 */

type Env = { Variables: { projectPath: string; projectName: string } };

export const designRoutes = new Hono<Env>();

function fail(c: Context<Env>, e: unknown): Response {
  const info = mapFsError(e);
  if (info.status >= 500) console.error(`[design] ${c.req.method} ${c.req.path}: ${info.message}`);
  return c.json(err(info.message), info.status as ContentfulStatusCode);
}

async function jsonBody(c: Context<Env>): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

designRoutes.get("/", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const [designs, system] = await Promise.all([listDesigns(projectPath), designSystemStatus(projectPath)]);
    return c.json(ok({ designs, system }));
  } catch (e) {
    return fail(c, e);
  }
});

designRoutes.post("/", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json(err("Expected a JSON object"), 400);
  try {
    return c.json(ok(await createDesign(c.get("projectPath"), { title: body.title, kind: body.kind })), 201);
  } catch (e) {
    return fail(c, e);
  }
});

designRoutes.get("/:slug", async (c) => {
  try {
    return c.json(ok(await getDesign(c.get("projectPath"), c.req.param("slug"))));
  } catch (e) {
    return fail(c, e);
  }
});

designRoutes.patch("/:slug", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json(err("Expected a JSON object"), 400);
  try {
    return c.json(ok(await renameDesign(c.get("projectPath"), c.req.param("slug"), body.title)));
  } catch (e) {
    return fail(c, e);
  }
});

/** Deleting needs `?confirm=<slug>`, so a stray or replayed request cannot drop a design. */
designRoutes.delete("/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (c.req.query("confirm") !== slug) return c.json(err("Confirm the deletion with ?confirm=<slug>"), 400);
  try {
    await deleteDesign(c.get("projectPath"), slug);
    return c.json(ok({ deleted: slug }));
  } catch (e) {
    return fail(c, e);
  }
});

designRoutes.get("/:slug/history", async (c) => {
  try {
    return c.json(ok(await listSnapshots(c.get("projectPath"), c.req.param("slug"))));
  } catch (e) {
    return fail(c, e);
  }
});

designRoutes.post("/:slug/history/:id/restore", async (c) => {
  // Hono hands the param over already decoded, so an encoded `..` is checked as `..`.
  const id = c.req.param("id");
  if (!isSnapshotId(id)) return c.json(err("Invalid snapshot id"), 400);
  try {
    return c.json(ok(await restoreSnapshot(c.get("projectPath"), c.req.param("slug"), id)));
  } catch (e) {
    return fail(c, e);
  }
});
