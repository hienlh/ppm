import { Hono, type Context } from "hono";
import { ok, err } from "../../types/api.ts";
import { fsErrorBody } from "../../services/fs-ops/fs-error-response.ts";
import { statPath } from "../../services/fs-ops/fs-ops-stat.service.ts";
import { copyPath, movePath } from "../../services/fs-ops/fs-ops-copy-move.service.ts";
import {
  deletePath,
  makeDir,
  renamePath,
  touchFile,
} from "../../services/fs-ops/fs-ops-mutate.service.ts";
import { trashPath } from "../../services/fs-ops/fs-ops-trash.service.ts";

/**
 * Out-of-project filesystem mutations for the explorer. Mounted on the same
 * `/api/fs` prefix as the browse routes; every handler resolves and whitelists
 * its paths inside the service layer and reports failures through one mapper
 * so the client always gets `{ error, code }`.
 */
export const fsOpsRoutes = new Hono();

function fail(c: Context, e: unknown) {
  const { body, status } = fsErrorBody(e);
  return c.json(body, status);
}

/** GET /api/fs/stat?path=... */
fsOpsRoutes.get("/stat", async (c) => {
  try {
    const path = c.req.query("path");
    if (!path) return c.json(err("path is required"), 400);
    return c.json(ok(await statPath(path)));
  } catch (e) {
    return fail(c, e);
  }
});

/** POST /api/fs/copy — body: { source, destination } */
fsOpsRoutes.post("/copy", async (c) => {
  try {
    const body = await c.req.json<{ source?: string; destination?: string }>();
    if (!body.source || !body.destination) {
      return c.json(err("source and destination are required"), 400);
    }
    return c.json(ok(await copyPath(body.source, body.destination)));
  } catch (e) {
    return fail(c, e);
  }
});

/** POST /api/fs/move — body: { source, destination } */
fsOpsRoutes.post("/move", async (c) => {
  try {
    const body = await c.req.json<{ source?: string; destination?: string }>();
    if (!body.source || !body.destination) {
      return c.json(err("source and destination are required"), 400);
    }
    return c.json(ok(await movePath(body.source, body.destination)));
  } catch (e) {
    return fail(c, e);
  }
});

/** POST /api/fs/rename — body: { path, newName } */
fsOpsRoutes.post("/rename", async (c) => {
  try {
    const body = await c.req.json<{ path?: string; newName?: string }>();
    if (!body.path || !body.newName) {
      return c.json(err("path and newName are required"), 400);
    }
    return c.json(ok(await renamePath(body.path, body.newName)));
  } catch (e) {
    return fail(c, e);
  }
});

/** POST /api/fs/touch — body: { path } */
fsOpsRoutes.post("/touch", async (c) => {
  try {
    const body = await c.req.json<{ path?: string }>();
    if (!body.path) return c.json(err("path is required"), 400);
    return c.json(ok(await touchFile(body.path)), 201);
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * DELETE /api/fs/delete — body: { path, permanent?: boolean }
 * Default is the OS trash so the action stays undoable; when no trash backend
 * exists the answer is 409 NO_TRASH and the client asks about a hard delete.
 */
async function handleDelete(c: Context) {
  try {
    type DeleteBody = { path?: string; permanent?: boolean };
    // A DELETE without a body is a client mistake, not a server error.
    const body = await c.req.json<DeleteBody>().catch((): DeleteBody => ({}));
    if (!body.path) return c.json(err("path is required"), 400);
    if (body.permanent) {
      const result = await deletePath(body.path);
      return c.json(ok({ ...result, trashed: false, permanent: true }));
    }
    const result = await trashPath(body.path);
    return c.json(ok({ removed: result.path, trashed: true, permanent: false }));
  } catch (e) {
    return fail(c, e);
  }
}

fsOpsRoutes.delete("/delete", handleDelete);

/** DELETE /api/fs/rmdir — legacy name kept as an alias of /delete. */
fsOpsRoutes.delete("/rmdir", handleDelete);
