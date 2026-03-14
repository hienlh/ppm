import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { resolveProjectPath } from "../helpers/resolve-project.ts";
import {
  fileService,
  SecurityError,
  NotFoundError,
  ValidationError,
} from "../../services/file.service.ts";
import { ok, err } from "../../types/api.ts";

export const fileRoutes = new Hono();

/** Map error type to HTTP status code */
function errorStatus(e: unknown): ContentfulStatusCode {
  if (e instanceof SecurityError) return 403;
  if (e instanceof NotFoundError) return 404;
  if (e instanceof ValidationError) return 400;
  return 500;
}

/** GET /api/files/tree/:project?depth=3 */
fileRoutes.get("/tree/:project", (c) => {
  try {
    const project = c.req.param("project");
    const depth = parseInt(c.req.query("depth") ?? "3", 10);
    const projectPath = resolveProjectPath(project);
    const tree = fileService.getTree(projectPath, depth);
    return c.json(ok(tree));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** GET /api/files/read/:project?path=... */
fileRoutes.get("/read/:project", (c) => {
  try {
    const project = c.req.param("project");
    const filePath = c.req.query("path");
    if (!filePath) {
      return c.json(err("Missing query parameter: path"), 400);
    }
    const projectPath = resolveProjectPath(project);
    const result = fileService.readFile(projectPath, filePath);
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** PUT /api/files/write/:project — body: { path, content } */
fileRoutes.put("/write/:project", async (c) => {
  try {
    const project = c.req.param("project");
    const body = await c.req.json<{ path: string; content: string }>();
    if (!body.path || body.content === undefined) {
      return c.json(err("Missing required fields: path, content"), 400);
    }
    const projectPath = resolveProjectPath(project);
    fileService.writeFile(projectPath, body.path, body.content);
    return c.json(ok({ written: body.path }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** POST /api/files/create/:project — body: { path, type } */
fileRoutes.post("/create/:project", async (c) => {
  try {
    const project = c.req.param("project");
    const body = await c.req.json<{
      path: string;
      type: "file" | "directory";
    }>();
    if (!body.path || !body.type) {
      return c.json(err("Missing required fields: path, type"), 400);
    }
    const projectPath = resolveProjectPath(project);
    fileService.createFile(projectPath, body.path, body.type);
    return c.json(ok({ created: body.path, type: body.type }), 201);
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** DELETE /api/files/delete/:project — body: { path } */
fileRoutes.delete("/delete/:project", async (c) => {
  try {
    const project = c.req.param("project");
    const body = await c.req.json<{ path: string }>();
    if (!body.path) {
      return c.json(err("Missing required field: path"), 400);
    }
    const projectPath = resolveProjectPath(project);
    fileService.deleteFile(projectPath, body.path);
    return c.json(ok({ deleted: body.path }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** GET /api/files/compare/:project?file1=path1&file2=path2 */
fileRoutes.get("/compare/:project", (c) => {
  try {
    const project = c.req.param("project");
    const file1 = c.req.query("file1");
    const file2 = c.req.query("file2");
    if (!file1 || !file2) {
      return c.json(err("Missing query parameters: file1, file2"), 400);
    }
    const projectPath = resolveProjectPath(project);
    const original = fileService.readFile(projectPath, file1);
    const modified = fileService.readFile(projectPath, file2);
    return c.json(ok({ original: original.content, modified: modified.content }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** POST /api/files/rename/:project — body: { oldPath, newPath } */
fileRoutes.post("/rename/:project", async (c) => {
  try {
    const project = c.req.param("project");
    const body = await c.req.json<{ oldPath: string; newPath: string }>();
    if (!body.oldPath || !body.newPath) {
      return c.json(err("Missing required fields: oldPath, newPath"), 400);
    }
    const projectPath = resolveProjectPath(project);
    fileService.renameFile(projectPath, body.oldPath, body.newPath);
    return c.json(ok({ renamed: { from: body.oldPath, to: body.newPath } }));
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});

/** POST /api/files/move/:project — body: { source, destination } */
fileRoutes.post("/move/:project", async (c) => {
  try {
    const project = c.req.param("project");
    const body = await c.req.json<{ source: string; destination: string }>();
    if (!body.source || !body.destination) {
      return c.json(err("Missing required fields: source, destination"), 400);
    }
    const projectPath = resolveProjectPath(project);
    fileService.moveFile(projectPath, body.source, body.destination);
    return c.json(
      ok({ moved: { from: body.source, to: body.destination } }),
    );
  } catch (e) {
    return c.json(err((e as Error).message), errorStatus(e));
  }
});
