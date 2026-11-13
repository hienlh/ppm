import { noteDirectWrite, serverRequest, ServerDownError, type ServerRequestOptions } from "./ppm-server-client.ts";
import { withProgress } from "./request-progress.ts";

/**
 * How a `ppm` command reaches a project-scoped route: through the running PPM that holds the
 * database — the same route its screens call, so the checks are the server's and every open PPM
 * updates at once — and, only when no PPM holds the database, through that very route run inside
 * this process after the direct-write notice.
 *
 * `projectApiPath` spells a route the way the Assistant's `projectRoute` does, kept separate so
 * the CLI never imports the server's tool modules.
 */

export type ApiQuery = Record<string, string | number | boolean | null | undefined>;

/** `/project/<name>/<sub>` (under `/api`) with `query` appended; null and undefined values are left out. */
export function projectApiPath(project: string, sub: string, query: ApiQuery = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.append(key, String(value));
  }
  const search = params.toString();
  const path = `/project/${encodeURIComponent(project)}/${sub.replace(/^\/+/, "")}`;
  return search ? `${path}?${search}` : path;
}

/** `/api<path>` on the server, or on the project routes here when no server holds the database. */
export async function apiRequest<T>(method: string, path: string, body?: unknown, opts: ServerRequestOptions = {}): Promise<T> {
  try {
    return await serverRequest<T>(method, path, body, opts);
  } catch (e) {
    if (!(e instanceof ServerDownError)) throw e;
  }
  if (method !== "GET") await noteDirectWrite();
  return withProgress(() => runRouteHere<T>(method, path, body), opts.progress === true);
}

/** `/api/project/<project><sub>`, through the server or here. */
export function projectRequest<T>(method: string, project: string, sub: string, body?: unknown, opts: ServerRequestOptions = {}): Promise<T> {
  return apiRequest<T>(method, `/project/${encodeURIComponent(project)}${sub}`, body, opts);
}

/**
 * `GET /api<path>` answered as a download: the server's response, body unread, or the same route's
 * here when no server holds the database. The caller saves it with `Bun.write(file, response)`.
 */
export async function apiDownload(path: string, opts: ServerRequestOptions = {}): Promise<Response> {
  try {
    return await serverRequest("GET", path, undefined, { ...opts, raw: true });
  } catch (e) {
    if (!(e instanceof ServerDownError)) throw e;
  }
  const res = await routeResponseHere("GET", path, undefined);
  if (res.ok) return res;
  const json = await res.json().catch(() => null) as { error?: string } | null;
  throw new Error(json?.error ?? `HTTP ${res.status}`);
}

async function runRouteHere<T>(method: string, path: string, body: unknown): Promise<T> {
  const res = await routeResponseHere(method, path, body);
  const json = await res.json().catch(() => null) as { ok?: boolean; data?: T; error?: string } | null;
  if (!json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json.data as T;
}

async function routeResponseHere(method: string, path: string, body: unknown): Promise<Response> {
  const { configService } = await import("../../services/config.service.ts");
  if (!configService.isLoaded) configService.load();
  const { Hono } = await import("hono");
  const { projectScopedRouter } = await import("../../server/routes/project-scoped.ts");
  const { ANNOUNCE_CHAT_LIST_ENV_KEY } = await import("../../server/routes/chat-list-broadcast.ts");
  const { ANNOUNCE_DESIGN_LIST_ENV_KEY } = await import("../../server/routes/designs-broadcast.ts");
  const app = new Hono();
  app.route("/api/project/:projectName", projectScopedRouter);
  const init: RequestInit = { method };
  if (method !== "GET") {
    init.body = JSON.stringify(body ?? {});
    init.headers = { "Content-Type": "application/json" };
  }
  // No PPM runs to show the change, so there is nobody to announce it to.
  const silent = () => {};
  return app.request(`http://ppm.local/api${path}`, init, { [ANNOUNCE_CHAT_LIST_ENV_KEY]: silent, [ANNOUNCE_DESIGN_LIST_ENV_KEY]: silent });
}
