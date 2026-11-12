import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Json } from "../mcp-http-endpoint.ts";
import { PROJECT_REMOVE_TOOL, PROJECT_UPDATE_TOOL } from "../../shared/assistant-project-tool-names.ts";
import { isAssistantProject } from "../../shared/assistant-project.ts";
import { getPpmDir } from "../ppm-dir.ts";
import { ROUTE_RESERVED_PROJECT_NAMES } from "../project.service.ts";
import { projectFolderRefusal } from "../project-folder-refusal.ts";
import { projectRemoveSummary, projectUpdateSummary } from "./assistant-approval-summary-project.ts";
import { resolveAssistantProject } from "./assistant-project-scope.ts";
import type { ToolContext } from "./assistant-tool-family.ts";
import { errorResult, jsonResult, notApprovedResult } from "./assistant-tool-output.ts";

/**
 * `project_update` and `project_remove`: read the project list through PPM's route, check the
 * request, build the card from what PPM lists, ask, read the list again (the answer can come much
 * later), and only then call the route the project switcher calls. A move is held to the same
 * folder rules as adding a project, since the Assistant then reads the new folder unasked.
 */

export interface ProjectToolDeps {
  home?: string;
  ppmDir?: string;
  /** The session of the project's manager chat, or null. */
  managerSession: (projectPath: string) => Promise<string | null>;
  /** Whether that chat is running a turn now. */
  isRunning: (sessionId: string) => boolean;
}

type Listed = { name: string; path: string; color?: string };

const samePath = (a: string, b: string) =>
  process.platform === "win32" || process.platform === "darwin" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const nameSegment = (name: string) => `/api/projects/${encodeURIComponent(name)}`;

async function listProjects(ctx: ToolContext): Promise<Listed[] | string> {
  const r = await ctx.callRoute<Listed[]>("GET", "/api/projects");
  return r.ok && Array.isArray(r.data) ? r.data : `Could not read the project list: ${r.error ?? `PPM answered ${r.status}`}`;
}

/** Why the project's manager chat makes this change wait, or null. */
async function managerBusy(deps: ProjectToolDeps, project: Listed): Promise<string | null> {
  const session = await deps.managerSession(project.path);
  return session && deps.isRunning(session)
    ? `The manager chat of "${project.name}" is running a turn; wait until it finishes, then try again.`
    : null;
}

function nameProblem(name: string, current: string, projects: Listed[]): string | null {
  if (!name || name.length > 100 || /[/\\]/.test(name) || /\p{Cc}/u.test(name)) return "`name` must be 1-100 characters with no / or \\.";
  if (isAssistantProject(name) || ROUTE_RESERVED_PROJECT_NAMES.includes(name)) return `"${name}" is a name PPM keeps for itself; choose another.`;
  if (projects.some((p) => p.name === name && p.name !== current)) return `A project is already named "${name}".`;
  return null;
}

function folderProblem(abs: string, current: Listed, projects: Listed[], deps: ProjectToolDeps): string | null {
  if (!existsSync(abs)) return `There is no folder at ${abs}.`;
  if (!isDir(abs)) return `${abs} is a file, not a folder.`;
  const refusal = projectFolderRefusal(abs, deps.home ?? homedir(), deps.ppmDir ?? getPpmDir());
  if (refusal) return `${refusal} The Assistant does not move a project there; the user can do it themselves in PPM.`;
  const other = projects.find((p) => p.name !== current.name && samePath(p.path, abs));
  return other ? `${abs} is already the project "${other.name}".` : null;
}

export async function projectUpdate(ctx: ToolContext, args: Record<string, unknown>, deps: ProjectToolDeps): Promise<Json> {
  const before = await listProjects(ctx);
  if (typeof before === "string") return errorResult(before);
  const found = resolveAssistantProject(args.project, () => before);
  if (!found.ok) return errorResult(found.error);
  const project = before.find((p) => p.name === found.value.name)!;

  if (args.name !== undefined && typeof args.name !== "string") return errorResult("`name`, when given, must be text.");
  const asked = typeof args.name === "string" ? args.name.trim() : undefined;
  const newName = asked && asked !== project.name ? asked : undefined;
  if (newName) {
    const problem = nameProblem(newName, project.name, before);
    if (problem) return errorResult(`Not changed: ${problem}`);
  }
  let newPath: string | undefined;
  if (args.path !== undefined) {
    if (typeof args.path !== "string" || !isAbsolute(args.path.trim())) return errorResult("`path`, when given, must be a full path.");
    const abs = resolve(args.path.trim());
    if (!samePath(abs, project.path)) {
      const problem = folderProblem(abs, project, before, deps);
      if (problem) return errorResult(`Not moved: ${problem}`);
      newPath = abs;
    }
  }
  let color: string | null | undefined;
  if (args.color !== undefined) {
    if (args.color === null || args.color === "none") color = null;
    else if (typeof args.color === "string" && HEX_COLOR.test(args.color)) color = args.color.toLowerCase();
    else return errorResult("`color` must be #rrggbb, or null (or \"none\") to clear it.");
  }
  if (!newName && !newPath && color === undefined) return errorResult("Nothing to change: give a new `name`, `path` or `color`.");
  if (newName || newPath) {
    const busy = await managerBusy(deps, project);
    if (busy) return errorResult(`Not changed: ${busy}`);
  }

  const verdict = await ctx.ask({
    tool: PROJECT_UPDATE_TOOL,
    input: { project: project.name, ...(newName ? { name: newName } : {}), ...(newPath ? { path: newPath } : {}), ...(color !== undefined ? { color } : {}) },
    summary: projectUpdateSummary({ project, newName, newPath, color }),
  });
  if (verdict.verdict !== "approved") return notApprovedResult(`change project ${project.name}`, verdict);

  // The answer can come much later: the project may have been renamed, moved or removed since.
  const after = await listProjects(ctx);
  if (typeof after === "string") return errorResult(`Not changed: ${after}`);
  const now = after.find((p) => p.name === project.name);
  if (!now || !samePath(now.path, project.path)) return errorResult(`Not changed: "${project.name}" was renamed, moved or removed while the card waited. Read projects_list and ask again.`);
  const stale = (newName && nameProblem(newName, project.name, after)) || (newPath && folderProblem(newPath, project, after, deps))
    || ((newName || newPath) && await managerBusy(deps, project));
  if (stale) return errorResult(`Not changed: ${stale}`);

  let name = project.name;
  if (newName || newPath) {
    const r = await ctx.callRoute<Listed>("PATCH", nameSegment(project.name), { ...(newName ? { name: newName } : {}), ...(newPath ? { path: newPath } : {}) });
    if (!r.ok) return errorResult(`Not changed: ${r.error ?? `PPM answered ${r.status}`}`);
    name = r.data?.name ?? newName ?? project.name;
  }
  if (color !== undefined) {
    const r = await ctx.callRoute("PATCH", `${nameSegment(name)}/color`, { color });
    if (!r.ok) return errorResult(`${name !== project.name || newPath ? "The project was renamed or moved, but its" : "The"} colour was not set: ${r.error ?? `PPM answered ${r.status}`}`);
  }
  return jsonResult({ outcome: "updated", name, path: newPath ?? project.path, ...(color !== undefined ? { color } : {}) });
}

export async function projectRemove(ctx: ToolContext, args: Record<string, unknown>, deps: ProjectToolDeps): Promise<Json> {
  const before = await listProjects(ctx);
  if (typeof before === "string") return errorResult(before);
  const found = resolveAssistantProject(args.project, () => before);
  if (!found.ok) return errorResult(found.error);
  const project = before.find((p) => p.name === found.value.name)!;
  // The route also matches a project by its folder: a name that reads as another project's folder would take that one too.
  const alsoMatched = before.find((p) => p.name !== project.name && samePath(p.path, project.name));
  if (alsoMatched) return errorResult(`Not removed: the name "${project.name}" is also the folder of "${alsoMatched.name}". Remove it in PPM instead.`);
  const busy = await managerBusy(deps, project);
  if (busy) return errorResult(`Not removed: ${busy}`);
  const managerChat = (await deps.managerSession(project.path)) !== null;

  const verdict = await ctx.ask({
    tool: PROJECT_REMOVE_TOOL,
    input: { project: project.name },
    summary: projectRemoveSummary({ project, git: existsSync(resolve(project.path, ".git")), managerChat }),
  });
  if (verdict.verdict !== "approved") return notApprovedResult(`remove project ${project.name}`, verdict);

  const after = await listProjects(ctx);
  if (typeof after === "string") return errorResult(`Not removed: ${after}`);
  const now = after.find((p) => p.name === project.name);
  if (!now || !samePath(now.path, project.path)) return errorResult(`Not removed: "${project.name}" was renamed, moved or removed while the card waited. Read projects_list and ask again.`);
  const stillBusy = await managerBusy(deps, project);
  if (stillBusy) return errorResult(`Not removed: ${stillBusy}`);

  const r = await ctx.callRoute("DELETE", nameSegment(project.name));
  if (!r.ok) return errorResult(`Not removed: ${r.error ?? `PPM answered ${r.status}`}`);
  return jsonResult({ outcome: "removed", name: project.name, path: project.path, note: "The folder and the chat transcripts stay on disk." });
}
