import { noteDirectWrite, serverRequest, ServerDownError } from "./ppm-server-client.ts";

/**
 * How a `ppm` settings command reaches PPM: through the running PPM that holds the database — the
 * same `/api/settings/*` route its screens call, so the checks are the server's, the change lands
 * in its memory, and every open PPM refreshes the section — and, only when no PPM holds the
 * database, through those very routes run inside this process after the direct-write notice.
 */
export async function settingsRequest<T>(method: string, sub: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
  const path = `/settings${sub}`;
  try {
    return await serverRequest<T>(method, path, body, opts);
  } catch (e) {
    if (!(e instanceof ServerDownError)) throw e;
  }
  if (method !== "GET") await noteDirectWrite();
  return runSettingsRouteHere<T>(method, path, body);
}

async function runSettingsRouteHere<T>(method: string, path: string, body: unknown): Promise<T> {
  const { configService } = await import("../../services/config.service.ts");
  if (!configService.isLoaded) configService.load();
  const { Hono } = await import("hono");
  const { settingsRoutes } = await import("../../server/routes/settings.ts");
  const { settingsProxyRoutes } = await import("../../server/routes/settings-proxy.ts");
  const { settingsThemesRoutes } = await import("../../server/routes/settings-themes.ts");
  const { ANNOUNCE_SETTINGS_ENV_KEY } = await import("../../server/routes/settings-broadcast.ts");
  const app = new Hono();
  app.route("/api/settings/themes", settingsThemesRoutes);
  app.route("/api/settings", settingsRoutes);
  app.route("/api/settings", settingsProxyRoutes);
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
