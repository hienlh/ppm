import { resolve } from "node:path";
import type { SessionFileChange } from "../../shared/session-file-changes.ts";
import type { SessionTurnCalls } from "../../services/session-file-baselines/session-turn-calls.ts";
import { fail, projectRequest, sessionSub, type ChatTarget } from "./chat-cmd-request.ts";

/**
 * How `ppm chat changes`, `ppm chat turns` and `ppm chat revert-turn` read a chat's review: through
 * the routes its Review tab calls (`chat-cmd-request.ts`), so the list, each file's version and its
 * blocks are the ones PPM shows. The list is asked for with the paths the chat's own tool calls name,
 * as the browser does, and every answer goes with the version just read.
 */

export const reviewSub = (t: ChatTarget, rest = "") => sessionSub(t.id, `/file-changes${rest}`);

export function readTurns(t: ChatTarget, limit?: number): Promise<SessionTurnCalls> {
  const query = new URLSearchParams();
  if (limit !== undefined) query.set("limit", String(limit));
  if (t.providerId) query.set("providerId", t.providerId);
  const q = query.toString();
  return projectRequest<SessionTurnCalls>("GET", t.project, `${reviewSub(t, "/turns")}${q ? `?${q}` : ""}`);
}

export async function readFiles(t: ChatTarget): Promise<SessionFileChange[]> {
  const { paths } = await readTurns(t);
  const r = await projectRequest<{ files: SessionFileChange[] }>("POST", t.project, reviewSub(t), { paths });
  return r.files;
}

/** The registered folder of the chat's project, which relative paths are read against. */
export async function projectPathOf(project: string): Promise<string> {
  const { configService } = await import("../../services/config.service.ts");
  if (!configService.isLoaded) configService.load();
  const found = configService.get("projects").find((p) => p.name === project);
  if (found) return found.path;
  const { assistantWorkDir } = await import("../../services/assistant/assistant-work-dir.ts");
  return assistantWorkDir();
}

const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The listed file `path` names (absolute, relative to the project, or to the current folder). */
export function pickListed(files: SessionFileChange[], projectPath: string, path: string): SessionFileChange {
  const wanted = [path, resolve(projectPath, path), resolve(path)];
  return files.find((f) => wanted.some((w) => same(f.path, w)))
    ?? fail(`"${path}" is not among this chat's changed files; see \`ppm chat changes list\``);
}

/** The path as a list shows it: relative to the project when inside it. */
export function shownPath(path: string, projectPath: string): string {
  const root = projectPath.replace(/[\\/]+$/, "");
  return path.length > root.length && same(path.slice(0, root.length), root) && /[\\/]/.test(path[root.length]!)
    ? path.slice(root.length + 1)
    : path;
}

/** `+3 −1`, or what stands in for line counts that could not be taken. */
export const lineCounts = (f: Pick<SessionFileChange, "additions" | "deletions">) =>
  f.additions === undefined && f.deletions === undefined ? "binary or too large" : `+${f.additions ?? 0} −${f.deletions ?? 0}`;
