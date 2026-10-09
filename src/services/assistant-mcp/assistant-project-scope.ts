import { projectService } from "../project.service.ts";
import { getSessionProvider, resolveMigratedSession } from "../db.service.ts";
import { isAssistantProject } from "../../shared/assistant-project.ts";
import { isAssistantSession } from "../assistant/assistant-session.ts";
import { SESSION_ID_RE, assertSessionInProject } from "../agent-transcript/session-ownership.ts";

/**
 * What the PPM Assistant's tools may point at: a registered project by its name, and a chat
 * session proven to belong to that project. The Assistant's own virtual project and its own
 * sessions are never a target — they are not the user's work, and reading one Assistant chat
 * from another would feed it its own earlier output as material.
 */

export interface AssistantProject {
  name: string;
  path: string;
}

export type Scoped<T> = { ok: true; value: T } | { ok: false; error: string };

export interface AssistantSessionTarget {
  /** The id that owns the transcript now, after any provider rename. */
  sessionId: string;
  providerId: "claude" | "codex";
}

const PROVIDERS = ["claude", "codex"] as const;

/** The registered project named `name`; anything else is refused with a reason the agent can act on. */
export function resolveAssistantProject(
  name: unknown,
  list: () => AssistantProject[] = () => projectService.list(),
): Scoped<AssistantProject> {
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false, error: "`project` is required: the name of a registered project (see projects_list)." };
  }
  if (isAssistantProject(name)) {
    return { ok: false, error: "The Assistant's own chats are not a project. Name one of the user's projects (see projects_list)." };
  }
  const project = list().find((p) => p.name === name);
  if (!project) return { ok: false, error: `No registered project is named "${name.slice(0, 100)}". Call projects_list for the names.` };
  return { ok: true, value: { name: project.name, path: project.path } };
}

/**
 * The session `sessionId` names, proven to be a chat of `project`: its transcript has to sit
 * where that provider files the project's sessions. `providerId` narrows the search when the
 * caller knows it; otherwise the recorded provider is tried, then both.
 */
export function resolveAssistantSessionTarget(
  project: AssistantProject,
  sessionId: unknown,
  providerId?: unknown,
): Scoped<AssistantSessionTarget> {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    return { ok: false, error: "`sessionId` is not a valid session id; take one from chat_list_sessions or chat_search." };
  }
  if (providerId !== undefined && providerId !== null && !PROVIDERS.includes(providerId as never)) {
    return { ok: false, error: "`providerId` must be \"claude\" or \"codex\"." };
  }
  const id = resolveMigratedSession(sessionId);
  if (isAssistantSession(sessionId) || isAssistantSession(id)) {
    return { ok: false, error: "That is a PPM Assistant chat, not one of the project's chats." };
  }
  const recorded = getSessionProvider(id);
  const candidates = providerId
    ? [providerId as AssistantSessionTarget["providerId"]]
    : PROVIDERS.includes(recorded as never) ? [recorded as AssistantSessionTarget["providerId"]] : [...PROVIDERS];
  for (const candidate of candidates) {
    const owned = assertSessionInProject({ providerId: candidate, sessionId: id, projectPath: project.path });
    if (owned.ok) return { ok: true, value: { sessionId: id, providerId: candidate } };
  }
  return { ok: false, error: `Session ${sessionId} is not a chat of project "${project.name}".` };
}
