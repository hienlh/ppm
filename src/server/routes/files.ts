import { Hono } from "hono";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  fileService,
  SecurityError,
  NotFoundError,
  ValidationError,
} from "../../services/file.service.ts";
import { ok, err } from "../../types/api.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

export const fileRoutes = new Hono<Env>();

/** Map error type to HTTP status code */
function errorStatus(e: unknown): ContentfulStatusCode {
  if (e instanceof SecurityError) return 403;
  if (e instanceof NotFoundError) return 404;
  if (e instanceof ValidationError) return 400;
  return 500;
}

/** GET /files/tree?depth=3 */
fileRoutes.get("/tree", (c) => {
  try {
    const projectPath = c.get("projectPath");
    const depth = parseInt(c.req.query("depth") ?? "3", 10);
    const tree = fileService.getTree(projectPath, depth);
    return c.json(ok(tree));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** GET /files/raw?path=... — serve file directly as binary (for PDF viewer, images, etc.) */
fileRoutes.get("/raw", (c) => {
  try {
    const projectPath = c.get("projectPath");
    const filePath = c.req.query("path");
    if (!filePath) return c.json(err("Missing query parameter: path"), 400);

    // Resolve safely (reuse service's security check)
    const absPath = resolve(projectPath, filePath);
    if (!absPath.startsWith(projectPath)) {
      return c.json(err("Access denied"), 403);
    }
    if (!existsSync(absPath)) return c.json(err("File not found"), 404);

    const file = Bun.file(absPath);
    return new Response(file.stream(), {
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "Content-Disposition": "inline",
      },
    });
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** GET /files/read?path=... */
fileRoutes.get("/read", (c) => {
  try {
    const projectPath = c.get("projectPath");
    const filePath = c.req.query("path");
    if (!filePath) {
      return c.json(err("Missing query parameter: path"), 400);
    }
    const result = fileService.readFile(projectPath, filePath);
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** PUT /files/write — body: { path, content } */
fileRoutes.put("/write", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const body = await c.req.json<{ path: string; content: string }>();
    if (!body.path || body.content === undefined) {
      return c.json(err("Missing required fields: path, content"), 400);
    }
    fileService.writeFile(projectPath, body.path, body.content);
    return c.json(ok({ written: body.path }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** POST /files/create — body: { path, type } */
fileRoutes.post("/create", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const body = await c.req.json<{ path: string; type: "file" | "directory" }>();
    if (!body.path || !body.type) {
      return c.json(err("Missing required fields: path, type"), 400);
    }
    fileService.createFile(projectPath, body.path, body.type);
    return c.json(ok({ created: body.path, type: body.type }), 201);
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** DELETE /files/delete — body: { path } */
fileRoutes.delete("/delete", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const body = await c.req.json<{ path: string }>();
    if (!body.path) {
      return c.json(err("Missing required field: path"), 400);
    }
    fileService.deleteFile(projectPath, body.path);
    return c.json(ok({ deleted: body.path }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** GET /files/compare?file1=path1&file2=path2 */
fileRoutes.get("/compare", (c) => {
  try {
    const projectPath = c.get("projectPath");
    const file1 = c.req.query("file1");
    const file2 = c.req.query("file2");
    if (!file1 || !file2) {
      return c.json(err("Missing query parameters: file1, file2"), 400);
    }
    const original = fileService.readFile(projectPath, file1);
    const modified = fileService.readFile(projectPath, file2);
    return c.json(ok({ original: original.content, modified: modified.content }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** POST /files/rename — body: { oldPath, newPath } */
fileRoutes.post("/rename", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const body = await c.req.json<{ oldPath: string; newPath: string }>();
    if (!body.oldPath || !body.newPath) {
      return c.json(err("Missing required fields: oldPath, newPath"), 400);
    }
    fileService.renameFile(projectPath, body.oldPath, body.newPath);
    return c.json(ok({ renamed: { from: body.oldPath, to: body.newPath } }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** POST /files/move — body: { source, destination } */
fileRoutes.post("/move", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const body = await c.req.json<{ source: string; destination: string }>();
    if (!body.source || !body.destination) {
      return c.json(err("Missing required fields: source, destination"), 400);
    }
    fileService.moveFile(projectPath, body.source, body.destination);
    return c.json(ok({ moved: { from: body.source, to: body.destination } }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});
