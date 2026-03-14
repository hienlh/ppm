import { Hono } from "hono";
import type { ProjectService } from "../../services/project.service.ts";

export function createProjectRoutes(projectService: ProjectService) {
  const app = new Hono();

  app.get("/", (c) => {
    try {
      const data = projectService.list();
      return c.json({ ok: true, data });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/", async (c) => {
    try {
      const body = await c.req.json<{ path: string; name?: string }>();
      if (!body.path) {
        return c.json({ ok: false, error: "path is required" }, 400);
      }
      projectService.add(body.path, body.name);
      return c.json({ ok: true }, 201);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 400);
    }
  });

  app.delete("/:name", (c) => {
    try {
      const name = c.req.param("name");
      projectService.remove(name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 404);
    }
  });

  return app;
}
