import { noteDirectWrite, serverRequest, ServerDownError } from "./ppm-server-client.ts";

/**
 * How a `ppm` settings command reaches PPM: through the running PPM that holds the database — the
 * same `/api/...` route its screens call, so the checks are the server's, the change lands in its
 * memory, and every open PPM refreshes the section — and, only when no PPM holds the database,
 * through those very routes run inside this process after the direct-write notice.
 *
 * `serverOnly` names work only a running PPM can do (a Telegram bridge, a connect link waiting for
 * a chat): with no server, the command stops with that reason instead of running the route here.
 */
export interface PpmRequestOptions { timeoutMs?: number; serverOnly?: string }

/** `path` is under `/api` (e.g. `/notifications/ntfy`). */
export async function ppmApiRequest<T>(method: string, path: string, body?: unknown, opts: PpmRequestOptions = {}): Promise<T> {
  try {
    return await serverRequest<T>(method, path, body, { timeoutMs: opts.timeoutMs });
  } catch (e) {
    if (!(e instanceof ServerDownError)) throw e;
    if (opts.serverOnly) throw new Error(`${opts.serverOnly} Start PPM (\`ppm start\`) and run this again.`);
  }
  if (method !== "GET") await noteDirectWrite();
  return runRouteHere<T>(method, path, body);
}

/** `sub` is under `/api/settings` (e.g. `/theme`). */
export function settingsRequest<T>(method: string, sub: string, body?: unknown, opts: PpmRequestOptions = {}): Promise<T> {
  return ppmApiRequest<T>(method, `/settings${sub}`, body, opts);
}

async function runRouteHere<T>(method: string, path: string, body: unknown): Promise<T> {
  const { configService } = await import("../../services/config.service.ts");
  if (!configService.isLoaded) configService.load();
  const { Hono } = await import("hono");
  const { settingsRoutes } = await import("../../server/routes/settings.ts");
  const { settingsProxyRoutes } = await import("../../server/routes/settings-proxy.ts");
  const { settingsThemesRoutes } = await import("../../server/routes/settings-themes.ts");
  const { ANNOUNCE_SETTINGS_ENV_KEY } = await import("../../server/routes/settings-broadcast.ts");
  const app = new Hono();
  app.route("/api/settings/themes", settingsThemesRoutes);
  if (path.startsWith("/settings/mcp")) app.route("/api/settings/mcp", (await import("../../server/routes/mcp.ts")).mcpRoutes);
  app.route("/api/settings", settingsRoutes);
  app.route("/api/settings", settingsProxyRoutes);
  // The other routers are loaded only when asked for: the accounts one brings the token refresher.
  if (path.startsWith("/notifications")) app.route("/api/notifications", (await import("../../server/routes/notifications.ts")).notificationRoutes);
  if (path.startsWith("/accounts")) app.route("/api/accounts", (await import("../../server/routes/accounts.ts")).accountsRoutes);
  if (path.startsWith("/codex-accounts")) app.route("/api/codex-accounts", (await import("../../server/routes/codex-accounts.ts")).codexAccountsRoutes);
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "DELETE") {
    init.body = JSON.stringify(body ?? {});
    init.headers = { "Content-Type": "application/json" };
  }
  // No PPM runs to show the change, so there is nobody to announce it to.
  const res = await app.request(`http://ppm.local/api${path}`, init, { [ANNOUNCE_SETTINGS_ENV_KEY]: () => {} });
  const json = await res.json().catch(() => null) as { ok?: boolean; data?: T; error?: string } | null;
  if (!json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json.data as T;
}
