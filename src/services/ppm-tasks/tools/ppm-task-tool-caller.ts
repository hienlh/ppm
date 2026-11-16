/**
 * Who is calling a `ppm_task_*` tool, from the token's chat: the PPM Assistant, a project's
 * manager chat, or an ordinary chat — with the projects it may act on and how its changes are
 * signed in history. The scope always comes from the chat the token names, never from an id the
 * model supplied about itself.
 *
 * Also the two gates every path shares: whether a chat is offered the tools at all
 * (`ppmTaskToolOnFor`, the endpoint's list and call check) and whether a chat's project gets the
 * session tools' server attached for them (`ppmTasksAttachFor`, chat turns and the warm spare).
 */
import { getDb, getSessionDesignSlug, getSessionProjectPath, resolveMigratedSession } from "../../db.service.ts";
import { parseTaskRef } from "../../../shared/ppm-tasks-refs.ts";
import { projectKey as keyOf } from "../../project-name-for-path.ts";
import { anyPpmToolOn, ppmToolOffMessage, ppmToolOn, type PpmToolSwitches } from "../../../shared/ppm-tools.ts";
import { PPM_TASK_NOTIFY_MANAGER_TOOL, PPM_TASK_TOOLS, type PpmTaskTool } from "../../../shared/ppm-task-tools.ts";
import type { Via, WriteContext } from "../../../shared/ppm-tasks.ts";
import type { CollabCaller } from "../../session-collab/collab-context.ts";
import { getTaskProject, isTasksEnabled, listTaskProjects } from "../ppm-tasks-projects.service.ts";

export type TaskCallerKind = "assistant" | "manager" | "chat";

export interface TaskCaller {
  sessionId: string;
  kind: TaskCallerKind;
  /** How its changes are signed: "Assistant", "Manager <project>", the chat's title. */
  label: string;
  /** The project a manager or ordinary chat works in; null for the Assistant. */
  ownProjectKey: string | null;
  ownProjectName: string | null;
  /** An Assistant turn PPM started that nobody has written in: writes allowed, marked, put on a card. */
  unattended: boolean;
  /** `telegram` while the Assistant's current turn came from Telegram. */
  via: Via;
}

export interface TaskCallerEnv {
  isManagerChat(sessionId: string): boolean;
  /** Where the Assistant's user last wrote from in this session (the chat service knows). */
  turnChannel(sessionId: string, providerId: string): Promise<"telegram" | "ppm" | null>;
}

const MAX_LABEL = 200;

/** `channel`: where the Assistant's user last wrote from; ignored for any other chat. */
export function taskCallerFrom(c: CollabCaller, isManager: boolean, channel: "telegram" | "ppm" | null): TaskCaller {
  if (c.kind === "assistant") {
    const telegram = !c.unattended && channel === "telegram";
    return {
      sessionId: c.sessionId, kind: "assistant", label: "Assistant", ownProjectKey: null, ownProjectName: null,
      unattended: c.unattended, via: telegram ? "telegram" : "tool",
    };
  }
  const label = (isManager ? `Manager ${c.projectName}` : c.title || `Chat ${c.sessionId.slice(0, 8)}`).slice(0, MAX_LABEL);
  return {
    sessionId: c.sessionId, kind: isManager ? "manager" : "chat", label, ownProjectKey: keyOf(c.projectPath), ownProjectName: c.projectName,
    unattended: false, via: "tool",
  };
}

/** The write context a caller's change is recorded under. */
export function writeContextFor(caller: TaskCaller, reason?: string): WriteContext {
  return {
    actor: { kind: caller.kind, sessionId: caller.sessionId, label: caller.label },
    via: caller.via,
    ...(reason ? { reason } : {}),
    ...(caller.unattended ? { unattended: true } : {}),
  };
}

/** A registered project as a caller may name it. */
export interface TaskProjectRef { key: string; name: string; path: string }

/** Settings → Tools and the per-project switch, for a chat's project path. */
export function ppmTasksAttachFor(projectPath: string | null | undefined, ai: { tab_tools?: boolean; ppm_tools?: PpmToolSwitches }): boolean {
  if (!projectPath) return false;
  return anyPpmToolOn(ai, PPM_TASK_TOOLS) && isTasksEnabled(keyOf(projectPath));
}

export interface TaskGateEnv {
  ai(): { tab_tools?: boolean; ppm_tools?: PpmToolSwitches };
  isAssistantSession(sessionId: string): boolean;
  boundToExtension(sessionId: string): boolean;
}

/**
 * Why `tool` is not offered to the chat now, or null when it is. Settings → Tools governs every
 * chat, manager chats and the Assistant included. The Assistant then reaches every project with
 * Tasks on (checked per call); a manager or ordinary chat only while its own project has Tasks
 * on; a design chat or a chat an extension bound never.
 */
export function ppmTaskToolOffReason(tool: PpmTaskTool, sessionId: string, env: TaskGateEnv): string | null {
  if (!ppmToolOn(env.ai(), tool)) return ppmToolOffMessage(tool);
  const id = resolveMigratedSession(sessionId);
  if (env.isAssistantSession(id)) {
    return listTaskProjects({ enabledOnly: true }).length > 0 ? null : `${tool} did nothing: no project has Tasks switched on in PPM.`;
  }
  if (tool === PPM_TASK_NOTIFY_MANAGER_TOOL) return `${tool} is for the PPM Assistant only; PPM tells the manager about task changes by itself.`;
  if (getSessionDesignSlug(id) || env.boundToExtension(id)) return `${tool} is not available in this chat.`;
  const path = getSessionProjectPath(id) ?? getSessionProjectPath(sessionId);
  if (!path) return `${tool} did nothing: this chat has no project.`;
  const project = getTaskProject(keyOf(path));
  if (!project?.enabled) return `${tool} did nothing: Tasks is switched off for this chat's project in PPM.`;
  return null;
}

// ── Scope: which project, which task ────────────────────────────────────────

export class TaskToolRefusal extends Error {}
const refuse = (message: string): never => { throw new TaskToolRefusal(message); };

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Projects with Tasks on, by the name the user knows them under in PPM. */
export function enabledTaskProjects(projects: ReadonlyArray<{ name: string; path: string }>): TaskProjectRef[] {
  const byKey = new Map(projects.map((p) => [keyOf(p.path), p]));
  return listTaskProjects({ enabledOnly: true }).flatMap((t) => {
    const p = byKey.get(t.projectKey);
    return p ? [{ key: t.projectKey, name: p.name, path: p.path }] : [];
  });
}

const projectList = (refs: TaskProjectRef[]): string => (refs.length ? refs.map((r) => r.name).join(", ") : "none");

/**
 * The projects a call acts on. A manager or ordinary chat: its own project, which must have Tasks
 * on; naming another is refused. The Assistant: the project it names (one with Tasks on); with
 * none named, every such project when `many` is allowed, else a refusal asking it to name one.
 */
export function resolveScope(
  caller: TaskCaller, rawProject: unknown, projects: ReadonlyArray<{ name: string; path: string }>, many: boolean,
): TaskProjectRef[] {
  const named = typeof rawProject === "string" && rawProject.trim() ? rawProject.trim() : null;
  if (caller.kind !== "assistant") {
    const key = caller.ownProjectKey!;
    const own = projects.find((p) => keyOf(p.path) === key);
    const ownName = own?.name ?? caller.ownProjectName ?? key;
    if (named && !sameName(named, ownName)) refuse(`This chat can act on tasks of its own project (${ownName}) only.`);
    if (!isTasksEnabled(key)) refuse(`Tasks is switched off for ${ownName} in PPM.`);
    return [{ key, name: ownName, path: own?.path ?? getTaskProject(key)?.projectPath ?? key }];
  }
  const enabled = enabledTaskProjects(projects);
  if (!named) {
    if (many) return enabled;
    return refuse(`Name the project. Projects with Tasks on: ${projectList(enabled)}.`);
  }
  const found = projects.find((p) => sameName(p.name, named));
  if (!found) return refuse(`No project named "${named}" in PPM. Projects with Tasks on: ${projectList(enabled)}.`);
  const ref = enabled.find((r) => r.key === keyOf(found.path));
  if (!ref) return refuse(`Tasks is switched off for ${found.name} in PPM. Projects with Tasks on: ${projectList(enabled)}.`);
  return [ref];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The task `raw` names, within `scope`: an id, `project/123`, or `#123`/`123` in `defaultProject`.
 * A task outside the scope reads exactly like one that does not exist.
 */
export function resolveTaskId(raw: unknown, scope: readonly TaskProjectRef[], defaultProject: TaskProjectRef | null): { id: string; project: TaskProjectRef } {
  if (typeof raw !== "string" || !raw.trim()) return refuse("Name the task: project/123, #123 or its id.");
  const text = raw.trim();
  const notFound = (): never => refuse(`No task ${text} in ${scope.length === 1 ? scope[0]!.name : "the projects you can reach"}.`);
  if (UUID_RE.test(text)) {
    const row = getDb().query("SELECT id, project_key FROM tasks WHERE id = ? AND deleted_at IS NULL").get(text) as { id: string; project_key: string } | null;
    const project = row ? scope.find((s) => s.key === row.project_key) : undefined;
    return row && project ? { id: row.id, project } : notFound();
  }
  const ref = parseTaskRef(text);
  if (!ref) return refuse(`"${text}" is not a task reference: use project/123, #123 or the task's id.`);
  const project = ref.project ? scope.find((s) => sameName(s.name, ref.project!)) : defaultProject;
  if (!project) return ref.project ? notFound() : refuse("Name the project too: project/123.");
  const row = getDb().query("SELECT id FROM tasks WHERE project_key = ? AND number = ? AND deleted_at IS NULL").get(project.key, ref.number) as { id: string } | null;
  return row ? { id: row.id, project } : notFound();
}
