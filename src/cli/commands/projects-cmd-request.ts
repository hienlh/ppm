import { inAiChat } from "../../services/ai-chat-env.ts";
import { noteDirectWrite, serverRequest, ServerDownError } from "../utils/ppm-server-client.ts";

/**
 * How every `ppm projects` command that writes reaches PPM: through the running PPM that holds the
 * database, so its screens update at once, and — only when no PPM holds the database — through
 * the very same project routes run inside this process, after the direct-write notice. Either way
 * the checks are the routes' own, written once.
 */

export const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

export function fail(message: string): never {
  console.error(`${C.red}Error:${C.reset} ${message}`);
  process.exit(1);
}

/** `/api/projects<sub>` on the server, or on the project routes here when no server holds the database. */
export async function projectsRequest<T>(method: string, sub: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
  try {
    return await serverRequest<T>(method, `/projects${sub}`, body, opts);
  } catch (e) {
    if (!(e instanceof ServerDownError)) throw e;
  }
  if (method !== "GET") await noteDirectWrite();
  return runProjectRouteHere<T>(method, sub, body);
}

async function runProjectRouteHere<T>(method: string, sub: string, body: unknown): Promise<T> {
  const { configService } = await import("../../services/config.service.ts");
  if (!configService.isLoaded) configService.load();
  const { projectRoutes } = await import("../../server/routes/projects.ts");
  const { ANNOUNCE_PROJECTS_ENV_KEY } = await import("../../server/routes/projects-broadcast.ts");
  const init: RequestInit = { method };
  if (method !== "GET") {
    if (body instanceof FormData) init.body = body;
    else {
      init.body = JSON.stringify(body ?? {});
      init.headers = { "Content-Type": "application/json" };
    }
  }
  // No PPM runs to show the change, so there is nobody to announce it to.
  const res = await projectRoutes.request(`http://ppm.local${sub || "/"}`, init, { [ANNOUNCE_PROJECTS_ENV_KEY]: () => {} });
  const json = await res.json().catch(() => null) as { ok?: boolean; data?: T; error?: string } | null;
  if (!json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json.data as T;
}

/**
 * From an AI chat, a folder that would put logins or PPM's own data inside a project is refused
 * before any request. Advisory: the shell's approval card is the control; this only keeps an AI
 * from asking for something PPM's own Assistant would never ask for.
 */
export async function refuseFolderFromAiChat(abs: string, verb: string): Promise<void> {
  if (!inAiChat()) return;
  const { projectFolderRefusal } = await import("../../services/project-folder-refusal.ts");
  const refusal = projectFolderRefusal(abs);
  if (refusal) fail(`Not ${verb}: ${refusal} An AI chat does not register such a folder; the user can add it themselves from PPM's project switcher.`);
}

/** The project's name: given as a name, or as the path of a registered project. */
export async function projectNameFor(nameOrPath: string): Promise<string> {
  const list = await projectsRequest<Array<{ name: string; path: string }>>("GET", "");
  if (list.some((p) => p.name === nameOrPath)) return nameOrPath;
  const { resolve } = await import("node:path");
  const abs = resolve(nameOrPath);
  const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return list.find((p) => norm(p.path) === norm(abs))?.name ?? fail(`Project not found: ${nameOrPath}`);
}

/** The route path of one project's `sub` route, its name encoded as one segment. */
export const projectSub = (name: string, sub = ""): string => `/${encodeURIComponent(name)}${sub}`;
