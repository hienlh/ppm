import { noteDirectWrite, serverRequest, ServerDownError, type ServerRequestOptions } from "./ppm-server-client.ts";
import { withProgress } from "./request-progress.ts";

/**
 * How a `ppm` settings command reaches PPM: through the running PPM that holds the database — the
 * same `/api/...` route its screens call, so the checks are the server's, the change lands in its
 * memory, and every open PPM refreshes the section — and, only when no PPM holds the database,
 * through those very routes run inside this process after the direct-write notice.
 *
 * `serverOnly` names work only a running PPM can do (a Telegram bridge, a connect link waiting for
 * a chat): with no server, the command stops with that reason instead of running the route here.
 * `progress` and `timeoutHint` are for installs that run for minutes (`request-progress.ts`).
 */
export interface PpmRequestOptions extends ServerRequestOptions { serverOnly?: string }

/** `path` is under `/api` (e.g. `/notifications/ntfy`). */
export async function ppmApiRequest<T>(method: string, path: string, body?: unknown, opts: PpmRequestOptions = {}): Promise<T> {
  try {
    return await serverRequest<T>(method, path, body, { timeoutMs: opts.timeoutMs, progress: opts.progress, timeoutHint: opts.timeoutHint });
  } catch (e) {
    if (!(e instanceof ServerDownError)) throw e;
    if (opts.serverOnly) throw new Error(`${opts.serverOnly} Start PPM (\`ppm start\`) and run this again.`);
  }
  if (method !== "GET") await noteDirectWrite();
  return withProgress(() => runRouteHere<T>(method, path, body), opts.progress === true);
}

/** `sub` is under `/api/settings` (e.g. `/theme`). */
export function settingsRequest<T>(method: string, sub: string, body?: unknown, opts: PpmRequestOptions = {}): Promise<T> {
  return ppmApiRequest<T>(method, `/settings${sub}`, body, opts);
}

/** No PPM runs to show a change made here, so every announcer is a no-op. */
const SILENT = () => {};

async function runRouteHere<T>(method: string, path: string, body: unknown): Promise<T> {
  const { configService } = await import("../../services/config.service.ts");
  if (!configService.isLoaded) configService.load();
  const { Hono } = await import("hono");
  const app = new Hono();
  const cleanups = await mountRoutersFor(app, path);
  try {
    return await requestHere<T>(app, method, path, body);
  } finally {
    // What a route started here (an extension host, a watcher's timer) would keep the command from exiting.
    for (const cleanup of cleanups) await cleanup().catch(() => {});
  }
}

async function requestHere<T>(app: import("hono").Hono, method: string, path: string, body: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "DELETE") {
    init.body = JSON.stringify(body ?? {});
    init.headers = { "Content-Type": "application/json" };
  }
  const { ANNOUNCE_SETTINGS_ENV_KEY } = await import("../../server/routes/settings-broadcast.ts");
  const { ANNOUNCE_EXTENSIONS_ENV_KEY } = await import("../../server/routes/extensions-broadcast.ts");
  const { ANNOUNCE_JIRA_ENV_KEY } = await import("../../server/routes/jira-broadcast.ts");
  const env = { [ANNOUNCE_SETTINGS_ENV_KEY]: SILENT, [ANNOUNCE_EXTENSIONS_ENV_KEY]: SILENT, [ANNOUNCE_JIRA_ENV_KEY]: SILENT };
  const res = await app.request(`http://ppm.local/api${path}`, init, env);
  const json = await res.json().catch(() => null) as { ok?: boolean; data?: T; error?: string } | null;
  if (!json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json.data as T;
}

/** Only the routers a path needs are loaded: the accounts one brings the token refresher, the extensions one the host. */
async function mountRoutersFor(app: import("hono").Hono, path: string): Promise<Array<() => Promise<void>>> {
  const cleanups: Array<() => Promise<void>> = [];
  const under = (prefix: string) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);
  if (under("/settings")) {
    app.route("/api/settings/themes", (await import("../../server/routes/settings-themes.ts")).settingsThemesRoutes);
    if (under("/settings/mcp")) app.route("/api/settings/mcp", (await import("../../server/routes/mcp.ts")).mcpRoutes);
    app.route("/api/settings", (await import("../../server/routes/settings.ts")).settingsRoutes);
    app.route("/api/settings", (await import("../../server/routes/settings-proxy.ts")).settingsProxyRoutes);
  }
  if (under("/notifications")) app.route("/api/notifications", (await import("../../server/routes/notifications.ts")).notificationRoutes);
  if (under("/accounts")) app.route("/api/accounts", (await import("../../server/routes/accounts.ts")).accountsRoutes);
  if (under("/codex-accounts")) app.route("/api/codex-accounts", (await import("../../server/routes/codex-accounts.ts")).codexAccountsRoutes);
  if (under("/extensions")) {
    // The list and the bundled flag come from what is on disk; a server learns it at start.
    const { extensionService } = await import("../../services/extension.service.ts");
    await extensionService.discover();
    app.route("/api/extensions", (await import("../../server/routes/extensions.ts")).extensionRoutes);
    cleanups.push(() => extensionService.shutdown());
  }
  if (under("/lsp")) app.route("/api/lsp", (await import("../../server/routes/lsp.ts")).lspGlobalRoutes);
  if (under("/speech")) app.route("/api/speech", (await import("../../server/routes/speech.ts")).speechRoutes);
  if (under("/db/drivers")) app.route("/api/db/drivers", (await import("../../server/routes/database-drivers.ts")).databaseDriverRoutes);
  if (under("/jira")) {
    app.route("/api/jira", (await import("../../server/routes/jira.ts")).jiraRoutes);
    const { jiraWatcherService } = await import("../../services/jira-watcher.service.ts");
    cleanups.push(async () => jiraWatcherService.stopAll());
  }
  return cleanups;
}
