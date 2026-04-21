import { Hono } from "hono";
import { projectService } from "../../services/project.service.ts";
import { configService } from "../../services/config.service.ts";
import { searchGitDirs } from "../../services/git-dirs.service.ts";
import { invalidateIndexCache } from "../../services/file-list-index.service.ts";
import { ok, err } from "../../types/api.ts";
import type { ProjectSettings } from "../../types/project.ts";

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

/** PATCH /api/projects/reorder — reorder projects array */
projectRoutes.patch("/reorder", async (c) => {
  try {
    const body = await c.req.json<{ order: string[] }>();
    if (!Array.isArray(body.order)) {
      return c.json(err("Missing required field: order (string[])"), 400);
    }
    const projects = configService.get("projects");
    const orderMap = new Map(body.order.map((name, i) => [name, i]));
    const reordered = [...projects].sort((a, b) => {
      const ai = orderMap.get(a.name) ?? Infinity;
      const bi = orderMap.get(b.name) ?? Infinity;
      return ai - bi;
    });
    configService.set("projects", reordered);
    configService.save();
    return c.json(ok({ reordered: reordered.length }));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** PATCH /api/projects/:name/color — set project color */
projectRoutes.patch("/:name/color", async (c) => {
  try {
    const name = c.req.param("name");
    const body = await c.req.json<{ color: string | null }>();
    const projects = configService.get("projects");
    const idx = projects.findIndex((p) => p.name === name);
    if (idx === -1) return c.json(err(`Project not found: ${name}`), 404);
    const updated = { ...projects[idx]! };
    if (body.color) updated.color = body.color;
    else delete updated.color;
    projects[idx] = updated;
    configService.set("projects", projects);
    configService.save();
    return c.json(ok(updated));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** GET /api/projects/:name/settings — return per-project settings JSON */
projectRoutes.get("/:name/settings", (c) => {
  try {
    const name = c.req.param("name");
    const projects = configService.get("projects");
    const project = projects.find((p) => p.name === name);
    if (!project) return c.json(err(`Project not found: ${name}`), 404);
    const settings = configService.getProjectSettings(project.path);
    return c.json(ok(settings));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** PATCH /api/projects/:name/settings — merge-patch per-project settings, invalidate index cache */
projectRoutes.patch("/:name/settings", async (c) => {
  try {
    const name = c.req.param("name");
    const projects = configService.get("projects");
    const project = projects.find((p) => p.name === name);
    if (!project) return c.json(err(`Project not found: ${name}`), 404);

    const body = await c.req.json<ProjectSettings>();

    // Validate files.filesExclude / searchExclude are bounded arrays of strings
    if (body.files) {
      const f = body.files;
      if (f.filesExclude !== undefined) {
        if (!Array.isArray(f.filesExclude)) return c.json(err("files.filesExclude must be an array"), 400);
        f.filesExclude = f.filesExclude.filter((p) => typeof p === "string").slice(0, 200);
      }
      if (f.searchExclude !== undefined) {
        if (!Array.isArray(f.searchExclude)) return c.json(err("files.searchExclude must be an array"), 400);
        f.searchExclude = f.searchExclude.filter((p) => typeof p === "string").slice(0, 200);
      }
      if (f.useIgnoreFiles !== undefined && typeof f.useIgnoreFiles !== "boolean") {
        return c.json(err("files.useIgnoreFiles must be a boolean"), 400);
      }
    }

    configService.setProjectSettings(project.path, body);
    // Bust server-side index cache so next /files/index re-builds with new filters
    invalidateIndexCache(project.path);

    const updated = configService.getProjectSettings(project.path);
    return c.json(ok(updated));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** PATCH /api/projects/:name — update a project's name/path */
projectRoutes.patch("/:name", async (c) => {
  try {
    const name = c.req.param("name");
    const body = await c.req.json<{ name?: string; path?: string }>();
    const updated = projectService.update(name, body);
    return c.json(ok(updated));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
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
