import { resolve } from "node:path";
import { projectRequest } from "../utils/project-route.ts";

/**
 * How every `ppm chat` and `ppm tags` command that writes reaches PPM: through the running PPM
 * that holds the database — the project-scoped chat and tag routes its screens call, so the
 * checks are the server's and every open PPM's chat list updates at once — and, only when no PPM
 * holds the database, through those very routes run inside this process after the direct-write
 * notice.
 */

export const C = {
  reset: "\x1b[0m",
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

export const run = (work: () => Promise<void>) => async () => {
  try { await work(); } catch (e) { fail((e as Error).message); }
};

export { projectRequest };

/** A chat as a command names it: its full id, the project it lives in, its stored provider. */
export interface ChatTarget { id: string; project: string; providerId: string | null }

const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));

/** A project given as a name or a path, as the registered name (the Assistant's own name included). */
export async function projectNameOf(nameOrPath: string): Promise<string> {
  const { isAssistantProject } = await import("../../shared/assistant-project.ts");
  if (isAssistantProject(nameOrPath)) return nameOrPath;
  const { resolveProject } = await import("../utils/project-resolver.ts");
  return resolveProject({ project: nameOrPath }).name;
}

/** The project a command without `-p` works in: the registered project the current folder is in. */
export async function currentProjectName(project?: string): Promise<string> {
  if (project) return projectNameOf(project);
  const { resolveProject } = await import("../utils/project-resolver.ts");
  return resolveProject({}).name;
}

/**
 * The chat `idOrPrefix` names: a full id, or the start of one PPM keeps a record of (as
 * `ppm chat list` prints it). Its project is `-p` when given, else the one PPM recorded for it.
 */
export async function resolveChatTarget(idOrPrefix: string, project?: string): Promise<ChatTarget> {
  const { configService } = await import("../../services/config.service.ts");
  if (!configService.isLoaded) configService.load();
  const db = await import("../../services/db.service.ts");
  const raw = idOrPrefix.replace(/\.+$/, "");
  let id = raw;
  if (!db.getSessionProjectPath(raw)) {
    const found = raw.length >= 4 ? db.findSessionIdsByPrefix(raw, 2) : [];
    if (found.length > 1) fail(`"${raw}" is the start of more than one chat; give more of its id`);
    if (found.length === 1) id = found[0]!;
  }
  const providerId = db.getSessionProvider(id);
  if (project) return { id, project: await projectNameOf(project), providerId };
  const recorded = db.getSessionProjectPath(id);
  if (recorded) {
    const match = configService.get("projects").find((p) => norm(p.path) === norm(recorded));
    if (match) return { id, project: match.name, providerId };
    const { assistantWorkDir } = await import("../../services/assistant/assistant-work-dir.ts");
    const { ASSISTANT_PROJECT_NAME } = await import("../../shared/assistant-project.ts");
    if (norm(recorded) === norm(assistantWorkDir())) return { id, project: ASSISTANT_PROJECT_NAME, providerId };
  }
  return fail(`Cannot tell which project chat ${id} belongs to; pass -p <project>`);
}

/** `/chat/sessions/<id><sub>` for a chat's own routes. */
export const sessionSub = (id: string, sub = ""): string => `/chat/sessions/${encodeURIComponent(id)}${sub}`;
