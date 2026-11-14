/**
 * Which chat a session schedule runs in, as PPM can reach it now: the chat's current id (a Codex
 * chat is renamed during its first turn), its registered project and its provider. One resolver
 * for the deliverer and for the checks run before a schedule is saved, so a schedule is never
 * accepted for a chat the deliverer would then refuse.
 *
 * Only ordinary chats qualify. A PPM Assistant session runs on rules of its own, and a design
 * session is driven by its canvas; neither takes a prompt PPM sends on a timer.
 */
import { resolve } from "node:path";
import { configService } from "../config.service.ts";
import { claudeTranscriptExists } from "../claude-transcript-exists.ts";
import {
  getSessionDesignSlug, getSessionProjectPath, getSessionProvider, resolveMigratedSession, sessionIdAliases,
} from "../db.service.ts";
import { isAssistantSession } from "../assistant/assistant-session.ts";
import { isAssistantProject } from "../../shared/assistant-project.ts";
import { SESSION_ID_RE } from "../../shared/session-turn-ids.ts";

/** The providers a session schedule can deliver into: those with a chat socket door. */
export const SCHEDULE_PROVIDERS: readonly string[] = ["claude", "codex"];

export interface ScheduleTarget {
  /** The chat's current id. */
  sessionId: string;
  projectName: string;
  projectPath: string;
  providerId: string;
}

export type ScheduleTargetResolution = { ok: true; target: ScheduleTarget } | { ok: false; reason: string };

export interface ScheduleTargetDeps {
  canonical(sessionId: string): string;
  /** First value any id of the chat recorded (its canonical id first). */
  stored<T>(sessionId: string, read: (id: string) => T | null): T | null;
  /** Any id the chat had belongs to a design. */
  isDesign(sessionId: string): boolean;
  isAssistant(sessionId: string): boolean;
  /** A chat whose provider was never recorded is a Claude chat when Claude has its transcript. */
  hasClaudeTranscript(sessionId: string): boolean;
  /** A registered project holding `projectPath`; never the PPM Assistant's own. */
  projectByPath(projectPath: string): { name: string; path: string } | null;
  projectPath(sessionId: string): string | null;
  provider(sessionId: string): string | null;
}

export const liveScheduleTargetDeps: ScheduleTargetDeps = {
  canonical: resolveMigratedSession,
  stored: (sessionId, read) => {
    for (const id of sessionIdAliases(sessionId)) {
      const value = read(id);
      if (value !== null && value !== undefined) return value;
    }
    return null;
  },
  isDesign: (sessionId) => sessionIdAliases(sessionId).some((id) => getSessionDesignSlug(id) !== null),
  isAssistant: (sessionId) => isAssistantSession(sessionId),
  hasClaudeTranscript: claudeTranscriptExists,
  projectByPath: (projectPath) => {
    const project = configService.get("projects").find((p) => resolve(p.path) === resolve(projectPath));
    return project && !isAssistantProject(project.name) ? { name: project.name, path: project.path } : null;
  },
  projectPath: getSessionProjectPath,
  provider: getSessionProvider,
};

/** The chat a schedule aimed at `sessionId` runs in now, or why it cannot run there. */
export function resolveScheduleTarget(sessionId: string, deps: ScheduleTargetDeps = liveScheduleTargetDeps): ScheduleTargetResolution {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return { ok: false, reason: "That is not a chat id." };
  const id = deps.canonical(sessionId);
  if (deps.isAssistant(id)) return { ok: false, reason: "A PPM Assistant chat does not take scheduled prompts." };
  if (deps.isDesign(id)) {
    return { ok: false, reason: "A design session does not take scheduled prompts." };
  }
  const projectPath = deps.stored(id, deps.projectPath);
  if (!projectPath) return { ok: false, reason: "The chat this schedule runs in no longer exists." };
  const project = deps.projectByPath(projectPath);
  if (!project) return { ok: false, reason: "The chat's project is no longer registered in PPM." };
  const providerId = deps.stored(id, deps.provider) ?? (deps.hasClaudeTranscript(id) ? "claude" : null);
  if (!providerId || !SCHEDULE_PROVIDERS.includes(providerId)) {
    return { ok: false, reason: "The chat runs on a provider schedules cannot reach." };
  }
  return { ok: true, target: { sessionId: id, projectName: project.name, projectPath: project.path, providerId } };
}
