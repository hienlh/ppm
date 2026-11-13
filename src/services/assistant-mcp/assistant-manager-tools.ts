import { statSync } from "node:fs";
import type { Json } from "../mcp-http-endpoint.ts";
import { MANAGER_ASSIGN_TOOL, MANAGER_UNASSIGN_TOOL } from "../../shared/assistant-manager-tool-names.ts";
import { pinClaudeSessionDir } from "../agent-transcript/session-ownership.ts";
import { isUnattendedTurn } from "../chat-control/chat-control.ts";
import { createLogger } from "../logger.ts";
import { projectService } from "../project.service.ts";
import { resolveAssistantSessionTarget } from "./assistant-project-scope.ts";
import type { RouteRule } from "./assistant-route-rules.ts";
import type { FamilyHandler, FamilyHandlers, ToolContext } from "./assistant-tool-family.ts";
import { errorResult } from "./assistant-tool-output.ts";
import { managerAssign, managerUnassign, type ManagerToolDeps } from "./assistant-manager-write-tools.ts";

/**
 * The manager-chat tools' handlers. They reach no route: they call `managerChats`, the service
 * behind `PUT`/`DELETE /api/assistant/managers/:project` (the session list's "Set as manager chat"
 * and "Unset manager chat"), which writes the rules files and announces the change on `/ws/global`
 * itself.
 */
export const MANAGER_ROUTES: readonly RouteRule[] = [];

const log = createLogger("assistant-managers");

/** When the chat last wrote its transcript; only a Claude chat can be a manager. */
function claudeLastActivity(sessionId: string, providerId: string, projectPath: string): number | null {
  if (providerId !== "claude") return null;
  const dir = pinClaudeSessionDir(sessionId, projectPath);
  try {
    return dir ? statSync(`${dir}.jsonl`).mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * PPM's own answers, built for each call. The manager service and the chat registry are loaded
 * here rather than at the top — they reach the providers, which import the endpoint this family
 * serves — so the handler's reads (`managerOf`, `mode`, `unassign`) can stay synchronous, as the
 * card and its re-check need them to be.
 */
export async function realManagerToolDeps(): Promise<ManagerToolDeps> {
  const { managerChats } = await import("../assistant-managers/manager-chats.service.ts");
  const { managerChatTitle } = await import("../assistant-managers/manager-chats-announce.ts");
  const { chatTargetMode } = await import("../../server/ws/chat.ts");
  return {
    projects: () => projectService.list(),
    target: (project, sessionId, providerId) => resolveAssistantSessionTarget(project, sessionId, providerId),
    title: managerChatTitle,
    lastActivity: claudeLastActivity,
    mode: (sessionId) => chatTargetMode(sessionId, "claude").mode,
    managerOf: (projectPath) => {
      const row = managerChats.managerFor(projectPath);
      return row ? { sessionId: row.sessionId, providerId: row.providerId } : null;
    },
    checkAssign: (projectName, sessionId) => managerChats.checkAssign(projectName, sessionId),
    assign: async (projectName, sessionId, onlyIfNone) => {
      const { row, replaced } = await managerChats.assign(projectName, sessionId, "assistant", { onlyIfNone });
      log.info(`Manager chat of ${projectName} is now ${row.sessionId}${replaced ? ` (replaces ${replaced})` : ""}, set by the Assistant`);
      return { replaced };
    },
    unassign: (projectName) => {
      const removed = managerChats.unassign(projectName);
      if (removed) log.info(`${projectName} has no manager chat now, unset by the Assistant`);
      return removed;
    },
    unattended: (sessionId) => isUnattendedTurn(sessionId),
  };
}

type DepsHandler = (ctx: ToolContext, args: Record<string, unknown>, deps: ManagerToolDeps) => Promise<Json>;

/** A handler over `deps`, answering an unexpected failure as a tool error rather than a 500. */
const bind = (run: DepsHandler, deps: () => Promise<ManagerToolDeps>): FamilyHandler => async (ctx, args) => {
  try {
    return await run(ctx, args, await deps());
  } catch (e) {
    return errorResult(`The manager tool failed: ${(e as Error).message}. Nothing more was done.`);
  }
};

/** The handlers over given dependencies; tests pass their own. */
export function createManagerToolHandlers(deps: () => Promise<ManagerToolDeps> = realManagerToolDeps): FamilyHandlers {
  return {
    [MANAGER_ASSIGN_TOOL]: bind(managerAssign, deps),
    [MANAGER_UNASSIGN_TOOL]: bind(managerUnassign, deps),
  };
}

export const MANAGER_TOOL_HANDLERS: FamilyHandlers = createManagerToolHandlers();
