import { Hono } from "hono";
import type { FileService } from "../../services/file.service.ts";

export function createFileRoutes(fileService: FileService) {
  const app = new Hono();

  // GET /api/files/tree/:project?depth=3
  app.get("/tree/:project", (c) => {
    try {
      const project = c.req.param("project");
      const depth = parseInt(c.req.query("depth") ?? "3", 10);
      const data = fileService.getTree(project, isNaN(depth) ? 3 : depth);
      return c.json({ ok: true, data });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 400);
    }
  });

  // GET /api/files/read?path=...
  app.get("/read", async (c) => {
    try {
      const path = c.req.query("path");
      if (!path) return c.json({ ok: false, error: "path is required" }, 400);
      const data = await fileService.readFile(path);
      return c.json({ ok: true, data });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 400);
    }
  });

  // PUT /api/files/write
  app.put("/write", async (c) => {
    try {
      const body = await c.req.json<{ path: string; content: string }>();
      if (!body.path) return c.json({ ok: false, error: "path is required" }, 400);
      await fileService.writeFile(body.path, body.content ?? "");
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 400);
    }
  });

  // POST /api/files/create
  app.post("/create", async (c) => {
    try {
      const body = await c.req.json<{ path: string; type: "file" | "directory" }>();
      if (!body.path) return c.json({ ok: false, error: "path is required" }, 400);
      const type = body.type === "directory" ? "directory" : "file";
      await fileService.createFile(body.path, type);
      return c.json({ ok: true }, 201);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 400);
    }
  });

  // DELETE /api/files/delete?path=...
  app.delete("/delete", (c) => {
    try {
      const path = c.req.query("path");
      if (!path) return c.json({ ok: false, error: "path is required" }, 400);
      fileService.deleteFile(path);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 400);
    }
  });

  // POST /api/files/rename
  app.post("/rename", async (c) => {
    try {
      const body = await c.req.json<{ oldPath: string; newPath: string }>();
      if (!body.oldPath || !body.newPath) {
        return c.json({ ok: false, error: "oldPath and newPath are required" }, 400);
      }
      fileService.renameFile(body.oldPath, body.newPath);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 400);
    }
  });

  return app;
}
