import { Hono } from "hono";
import { projectService } from "../../services/project.service.ts";
import { fileBrowserScope, resolveFileBrowserTarget } from "../../services/file-browser-target.ts";
import {
  MAX_LOCATE_PATHS, type FileBrowserLocateEntry, type FileBrowserLocateResponse,
} from "../../shared/file-browser-target.ts";
import { ok, err } from "../../types/api.ts";

/**
 * `POST /api/fs/locate` — where the OS file browser should open for each of a batch of paths,
 * under the rules `resolveFileBrowserTarget` applies (PPM's folder, `~/.cloudflared` and the
 * stores the Assistant keeps private are refused). A `/files?path=` link asks for one path; a
 * finished AI answer asks for every path it names in one request, so a message costs one
 * round trip however many paths it holds.
 */
export const fsLocateRoutes = new Hono();

fsLocateRoutes.post("/locate", async (c) => {
  let body: { paths?: unknown; project?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(err("Body must be JSON: { paths: string[], project?: string }"), 400);
  }
  if (!Array.isArray(body.paths) || body.paths.some((p) => typeof p !== "string")) {
    return c.json(err("`paths` must be an array of strings"), 400);
  }
  if (body.paths.length > MAX_LOCATE_PATHS) {
    return c.json(err(`At most ${MAX_LOCATE_PATHS} paths per request`), 400);
  }
  const projects = projectService.list();
  const project = typeof body.project === "string" ? projects.find((p) => p.name === body.project) : undefined;
  // One scope for the whole batch: it lists the registered projects and the private roots.
  const scope = fileBrowserScope(projects.map((p) => p.path));
  const results: FileBrowserLocateEntry[] = [];
  for (const input of body.paths as string[]) {
    const outcome = await resolveFileBrowserTarget(input, { baseDir: project?.path ?? null, scope });
    results.push(outcome.ok ? { input, ok: true, ...outcome.value } : { input, ok: false, error: outcome.error });
  }
  const response: FileBrowserLocateResponse = { results };
  return c.json(ok(response));
});
