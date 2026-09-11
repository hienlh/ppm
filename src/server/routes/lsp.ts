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
import { lspManager } from "../../services/lsp/lsp-manager.ts";
import { lspLanguageForPath } from "../../services/lsp/server-registry.ts";
import { ok, err } from "../../types/api.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

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
    const running = lspManager.running().filter((entry) => entry.rootPath.startsWith(projectPath));

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
