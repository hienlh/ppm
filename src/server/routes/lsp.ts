/**
 * Language server status.
 *
 * This exists so "nothing is happening in the editor" has an answer. The
 * common case for a fresh PPM install is that no language server is installed
 * at all, which is indistinguishable from a broken feature unless something
 * says so — hence the install hint travelling with the availability.
 *
 * Installing is a POST, and nothing else here triggers one. A network install because a file
 * was opened is not a thing an editor should do on the user's behalf; pressing Install is.
 *
 * There are two routers because there are two questions. The editor asks about *this project*
 * — its `node_modules/.bin` counts, and a rustup component belongs in the toolchain that
 * project selects. Settings asks about *this machine*, with no project open at all. They share
 * the install handler, so neither can drift into accepting a package name.
 */
import { Hono, type Context } from "hono";
import { sep } from "node:path";
import { lspManager } from "../../services/lsp/lsp-manager.ts";
import { installLanguageServer, lspInstallDir, uninstallLanguageServer } from "../../services/lsp/lsp-install.ts";
import { lspLanguageForPath, serverById } from "../../services/lsp/server-registry.ts";
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

/**
 * POST /lsp/install — install the missing server, because someone pressed Install.
 *
 * The project, because `rustup component add` acts on the toolchain that directory selects.
 */
lspRoutes.post("/install", (c) => installServer(c, c.get("projectPath")));

/**
 * The machine-wide pair, for the Settings pane: `/api/lsp/*`.
 *
 * Settings is not open on a project, so there is no `node_modules/.bin` to consider and
 * `rustup component add` lands in whichever toolchain PPM's own directory selects — the
 * default one. That is the honest answer to "install rust-analyzer on this machine", and the
 * pane says so; a project pinning its own toolchain still gets it from the editor's button.
 */
export const lspGlobalRoutes = new Hono();

/** GET /api/lsp/servers — every registered server, whether the machine has it, and where installs go. */
lspGlobalRoutes.get("/servers", async (c) => {
  try {
    return c.json(ok({
      servers: await lspManager.availability(),
      installDir: lspInstallDir(),
      running: lspManager.running(),
    }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

lspGlobalRoutes.post("/install", (c) => installServer(c, undefined));

/**
 * POST /api/lsp/uninstall — remove a server, from the Settings pane.
 *
 * Only here, and not on the editor's router: that dialog is only ever shown for a server that
 * is *missing*, so it has nothing to remove. The gate is `removable`, which comes from where
 * the server was found rather than from what the browser claims — a copy on `PATH` is the
 * user's, and PPM has no business deleting it.
 */
lspGlobalRoutes.post("/uninstall", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const definition = serverById(String(body.serverId ?? ""));
  if (!definition) return c.json(err("No such language server"), 400);

  const row = (await lspManager.availability()).find((s) => s.id === definition.id);
  if (!row?.removable) {
    return c.json(err(`PPM did not install ${definition.displayName}, so there is nothing for it to remove.`), 400);
  }

  try {
    // The idle sessions first: the files are about to go, and on Windows a running binary
    // cannot be unlinked at all.
    await lspManager.stopIdle(definition.id);
    await uninstallLanguageServer(definition);
    return c.json(ok({ id: definition.id, displayName: definition.displayName }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * The one install handler, shared by both routers.
 *
 * The body carries a server **id** and nothing else: the packages are the registry's, so no
 * part of the command being run was chosen by the browser.
 */
async function installServer(c: Context, projectPath: string | undefined): Promise<Response> {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const definition = serverById(String(body.serverId ?? ""));
  if (!definition) return c.json(err("No such language server"), 400);
  if (!definition.install) {
    return c.json(err(`PPM cannot install ${definition.displayName}. Install it yourself: ${definition.installHint}`), 400);
  }

  try {
    await installLanguageServer(definition, { projectPath });
    return c.json(ok({ id: definition.id, displayName: definition.displayName }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
}

export default lspRoutes;
