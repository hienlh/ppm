import { Hono } from "hono";
import { existsSync, mkdirSync, rmSync, statSync } from "fs";
import { resolve } from "path";
import { $ } from "bun";
import {
  browse,
  list,
  readSystemFile,
  writeSystemFile,
} from "../../services/fs-browse.service.ts";
import { ok, err } from "../../types/api.ts";

export const fsBrowseRoutes = new Hono();

/** Map error to HTTP status (errors carry .status from service). */
function errorStatus(e: unknown): 400 | 403 | 404 | 500 {
  const status = (e as { status?: number }).status;
  if (status === 403 || status === 404 || status === 400) return status;
  return 500;
}

/** GET /api/fs/browse?path=/some/dir&showHidden=false */
fsBrowseRoutes.get("/browse", (c) => {
  try {
    const path = c.req.query("path") || undefined;
    const showHidden = c.req.query("showHidden") === "true";
    const result = browse(path, { showHidden });
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** GET /api/fs/list?dir=/some/dir — recursive file listing (command palette) */
fsBrowseRoutes.get("/list", (c) => {
  try {
    const dir = c.req.query("dir");
    if (!dir) return c.json(err("dir is required"), 400);
    const files = list(dir);
    return c.json(ok(files));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** GET /api/fs/read?path=/some/file — read file outside project */
fsBrowseRoutes.get("/read", (c) => {
  try {
    const filePath = c.req.query("path");
    if (!filePath) return c.json(err("path is required"), 400);
    const result = readSystemFile(filePath);
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** GET /api/fs/raw?path=/some/file — serve file as binary (for images in markdown, etc.) */
fsBrowseRoutes.get("/raw", (c) => {
  try {
    const filePath = c.req.query("path");
    if (!filePath) return c.json(err("path is required"), 400);
    if (!existsSync(filePath)) return c.json(err("File not found"), 404);

    const file = Bun.file(filePath);
    return new Response(file.stream(), {
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "Content-Disposition": "inline",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** DELETE /api/fs/rmdir — delete a directory { path } */
fsBrowseRoutes.delete("/rmdir", async (c) => {
  try {
    const body = await c.req.json<{ path: string }>();
    if (!body.path) return c.json(err("path is required"), 400);

    const abs = resolve(body.path);
    if (!existsSync(abs)) return c.json(err("Directory not found"), 404);
    if (!statSync(abs).isDirectory()) return c.json(err("Path is not a directory"), 400);

    rmSync(abs, { recursive: true });
    return c.json(ok({ removed: abs }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** POST /api/fs/mkdir — create directory and git init { path } */
fsBrowseRoutes.post("/mkdir", async (c) => {
  try {
    const body = await c.req.json<{ path: string }>();
    if (!body.path) return c.json(err("path is required"), 400);

    const abs = resolve(body.path);
    if (existsSync(abs)) {
      return c.json(err(`Directory already exists: ${abs}`), 400);
    }

    mkdirSync(abs, { recursive: true });
    // git init in the new directory
    await $`git init ${abs}`.quiet();
    return c.json(ok({ path: abs, gitInitialized: true }), 201);
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** PUT /api/fs/write — write file outside project { path, content } */
fsBrowseRoutes.put("/write", async (c) => {
  try {
    const body = await c.req.json<{ path: string; content: string }>();
    if (!body.path || body.content == null) {
      return c.json(err("path and content required"), 400);
    }
    writeSystemFile(body.path, body.content);
    return c.json(ok(true));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});
