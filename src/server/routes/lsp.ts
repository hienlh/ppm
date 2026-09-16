/**
 * Language server status.
 *
 * This exists so "nothing is happening in the editor" has an answer. The
 * common case for a fresh PPM install is that no language server is installed
 * at all, which is indistinguishable from a broken feature unless something
 * says so — hence the install hint travelling with the availability.
 *
 * Nothing here installs anything. A silent network install triggered by opening
 * a file is not a thing an editor should do on the user's behalf.
 */
import { Hono } from "hono";
import { sep } from "node:path";
import { lspManager } from "../../services/lsp/lsp-manager.ts";
import { lspLanguageForPath } from "../../services/lsp/server-registry.ts";
import { ok, err } from "../../types/api.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

/**
 * Is `rootPath` this project, or inside it?
 *
 * A bare `startsWith` is not that question: a project at `/srv/app` matched every server
 * rooted in `/srv/app2`, so the indicator reported a neighbour's server as this project's —
 * including its `ready` state, which is what the editor draws the server's name from.
 */
export function isWithinProject(rootPath: string, projectPath: string): boolean {
  return rootPath === projectPath || rootPath.startsWith(projectPath.endsWith(sep) ? projectPath : projectPath + sep);
}

export const lspRoutes = new Hono<Env>();

/**
 * GET /lsp/status — which servers this project can use, and what is running.
 *
 * `path` narrows it to the server that would serve one file, which is what the
 * editor's indicator asks for.
 */
lspRoutes.get("/status", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const available = await lspManager.availability(projectPath);
    const running = lspManager.running().filter((entry) => isWithinProject(entry.rootPath, projectPath));

    const filePath = c.req.query("path");
    const language = filePath ? lspLanguageForPath(filePath) : null;

    return c.json(ok({
      language,
      servers: language ? available.filter((s) => s.languages.includes(language)) : available,
      running,
    }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

export default lspRoutes;
