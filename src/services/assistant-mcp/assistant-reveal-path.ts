import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Json } from "../mcp-http-endpoint.ts";
import { projectService } from "../project.service.ts";
import { resolvePath } from "../fs-path-guard.service.ts";
import { tabReadRefusal } from "../tab-tools-mcp/tab-target.ts";
import { assistantPrivateScope, isAssistantPrivatePath } from "../assistant/assistant-private-paths.ts";
import type { AssistantRevealPathArgs, AssistantRevealPathResult } from "../../shared/assistant-ui-protocol.ts";
import { resolveAssistantProject, type AssistantProject, type Scoped } from "./assistant-project-scope.ts";
import { askDevice, assistantUiBroker, type UiRequest } from "./assistant-ui-tools.ts";
import { UI_NAV_WAIT_MS } from "./assistant-ui-nav-tools.ts";
import { errorResult, jsonResult } from "./assistant-tool-output.ts";

/**
 * `ui_reveal_path`: shows a folder or file in the project's own file tree — the sidebar's
 * Explorer on a desktop, the navigation drawer on a phone — with its parent folders opened, the
 * row scrolled into view and selected. Not the OS File Explorer window, which browses the whole
 * disk: the tree shows one project, so the path has to lie inside that project.
 *
 * Navigation only: nothing is read or written, the agent is told only that the path exists, so
 * no card. The path still has to pass the rules a read would — PPM's own folders refused as the
 * editor refuses them, and the stores the Assistant treats as private (`~/.ssh`, `.aws`…)
 * refused too — so the tool never puts a name from those places on screen.
 */

const MAX_PATH_CHARS = 4096;

/** Windows and macOS disks ignore case, so "inside" does too there, as `assistant-private-paths` does. */
const foldCase = process.platform === "win32" || process.platform === "darwin";
const fold = (p: string) => (foldCase ? p.toLowerCase() : p);
const isInside = (root: string, path: string): boolean => {
  const r = fold(root), p = fold(path);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
};

const NOT_INSIDE = (project: AssistantProject) => `is not inside project "${project.name}"; its Explorer shows only the project's own files. `
  + "Open a file elsewhere with ui_open_tab kind \"file\".";
const PRIVATE = "is where logins or keys are kept; PPM does not show it for the Assistant. Ask the user to open it.";

export interface RevealDeps {
  /** Every registered project's folder: what the private-store rule measures from. */
  projectRoots?: () => string[];
  home?: () => string;
  privateRoots?: () => string[];
}

/**
 * The path as the device's tree names it (relative, `/`-separated, `""` for the root), or why not.
 *
 * Every refusal that can be decided from the path as written is decided before the disk is
 * touched: a UNC path names another machine, and a private store must be refused the same way
 * whether or not the file in it exists, or the answer would say which keys are there. A refusal
 * after following links never names where a link leads.
 */
export async function resolveRevealPath(project: AssistantProject, input: unknown, deps: RevealDeps = {}): Promise<Scoped<{ path: string; kind: "file" | "folder" }>> {
  if (typeof input !== "string" || !input.trim()) {
    return { ok: false, error: "`path` is required: a folder or file of the project, relative to its folder (\".\" for the folder itself)." };
  }
  if (input.length > MAX_PATH_CHARS || input.includes("\0")) return { ok: false, error: "`path` is not a valid path." };
  const raw = input.trim();
  const absolute = isAbsolute(raw) || raw.startsWith("~") ? resolvePath(raw) : resolve(project.path, raw);
  const root = resolve(project.path);
  if (!isInside(root, absolute)) return { ok: false, error: `${absolute} ${NOT_INSIDE(project)}` };
  const early = tabReadRefusal(absolute, absolute);
  if (early) return { ok: false, error: early.replace("does not open", "does not show") };
  const scope = assistantPrivateScope({
    projectRoots: (deps.projectRoots ?? (() => projectService.list().map((p) => p.path)))(),
    ...(deps.home ? { home: deps.home() } : {}),
    ...(deps.privateRoots ? { roots: deps.privateRoots() } : {}),
  });
  if (isAssistantPrivatePath(absolute, scope)) return { ok: false, error: `${absolute} ${PRIVATE}` };
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return { ok: false, error: `There is nothing at ${absolute}.` };
  }
  const realRoot = await realpath(root).catch(() => root);
  if (!isInside(realRoot, real)) return { ok: false, error: `${absolute} leads outside the project through a link; ${NOT_INSIDE(project)}` };
  const late = tabReadRefusal(absolute, real);
  if (late) return { ok: false, error: late.replace("does not open", "does not show") };
  if (isAssistantPrivatePath(real, scope)) return { ok: false, error: `${absolute} ${PRIVATE}` };
  let folder: boolean;
  try {
    folder = (await stat(real)).isDirectory();
  } catch {
    return { ok: false, error: `${absolute} could not be read.` };
  }
  // Named from the disk's own spelling (the async realpath gives each name as stored), so a path
  // written in the wrong case on a disk that ignores case still matches the tree's rows.
  const path = fold(real) === fold(realRoot) ? "" : relative(realRoot, real).split(sep).join("/");
  return { ok: true, value: { path, kind: folder ? "folder" : "file" } };
}

function revealResult(data: unknown): AssistantRevealPathResult | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.path !== "string" || (d.kind !== "file" && d.kind !== "folder")) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return { path: d.path, kind: d.kind, project: str(d.project), previousProject: str(d.previousProject) };
}

export async function uiRevealPath(
  sessionId: string, args: Record<string, unknown>, request: UiRequest = assistantUiBroker.request, deps: RevealDeps = {},
): Promise<Json> {
  const project = resolveAssistantProject(args.project);
  if (!project.ok) return errorResult(project.error);
  const target = await resolveRevealPath(project.value, args.path, deps);
  if (!target.ok) return errorResult(target.error);
  const body: AssistantRevealPathArgs = { project: project.value.name, path: target.value.path, kind: target.value.kind };
  const answer = await askDevice(request, sessionId, { op: "reveal_path", args: { ...body } }, UI_NAV_WAIT_MS, "show it in the Explorer");
  if (!answer.ok) return answer.result;
  const result = revealResult(answer.data);
  if (!result) return errorResult("The device answered, but not with a result PPM understands; check with ui_get_state.");
  return jsonResult({ ...result });
}
