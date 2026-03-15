import { Hono } from "hono";
import { projectService } from "../../services/project.service.ts";
import { searchGitDirs } from "../../services/git-dirs.service.ts";
import { ok, err } from "../../types/api.ts";

export const projectRoutes = new Hono();

/** GET /api/projects — list all registered projects */
projectRoutes.get("/", (c) => {
  try {
    const projects = projectService.list();
    return c.json(ok(projects));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/projects — add a project { path, name? } */
projectRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json<{ path: string; name?: string }>();
    if (!body.path) {
      return c.json(err("Missing required field: path"), 400);
    }
    const project = projectService.add(body.path, body.name);
    return c.json(ok(project), 201);
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/**
 * GET /api/projects/suggest-dirs?path=/some/dir&q=search
 * Deep-scan `path` (default: home dir) for directories containing .git.
 * Results are cached for 5 minutes. Use `q` to filter by name/path.
 */
projectRoutes.get("/suggest-dirs", (c) => {
  try {
    const root = c.req.query("path") || undefined;
    const query = c.req.query("q") ?? "";
    const results = searchGitDirs(query, root);
    return c.json(ok(results));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** DELETE /api/projects/:name — remove a project by name */
projectRoutes.delete("/:name", (c) => {
  try {
    const name = c.req.param("name");
    projectService.remove(name);
    return c.json(ok({ removed: name }));
  } catch (e) {
    return c.json(err((e as Error).message), 404);
  }
});
