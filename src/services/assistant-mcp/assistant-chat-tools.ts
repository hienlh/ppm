import type { Json } from "../mcp-http-endpoint.ts";
import { CHAT_DELETE_TOOL, CHAT_ORGANIZE_TOOL, CHAT_STOP_TOOL } from "../../shared/assistant-chat-tool-names.ts";
import { chatControl, isUnattendedTurn } from "../chat-control/chat-control.ts";
import { getPinnedSessionIds } from "../db.service.ts";
import { projectService } from "../project.service.ts";
import { hasChildren } from "../session-branch.service.ts";
import { getSessionTags } from "../tag.service.ts";
import { watchedChatTitle } from "../assistant-watch/watched-chat-title.ts";
import { chatOrganize } from "./assistant-chat-organize-tool.ts";
import type { ChatToolDeps } from "./assistant-chat-tool-target.ts";
import { chatDelete, chatStop } from "./assistant-chat-write-tools.ts";
import { resolveAssistantSessionTarget } from "./assistant-project-scope.ts";
import { assistantRecentUnpins } from "./assistant-recent-unpins.ts";
import { allowRoute, type RouteRule } from "./assistant-route-rules.ts";
import type { FamilyHandler, FamilyHandlers, ToolContext } from "./assistant-tool-family.ts";
import { errorResult } from "./assistant-tool-output.ts";

/**
 * The chat tools' handlers and the only routes they may call: one chat session's title, pin, tag
 * and read marks, its deletion, and the project's tag list — never its transcript, an upload or
 * a draft (`assistant-route-call.ts` gates the project router the same way). Stopping a turn
 * needs no route: it goes through `chatControl`, the code PPM's Stop button runs.
 */
export const CHAT_ROUTES: readonly RouteRule[] = [
  allowRoute("PATCH", "/api/project/:project/chat/sessions/:id"),
  allowRoute("DELETE", "/api/project/:project/chat/sessions/:id", ["providerId", "stopRunning"]),
  allowRoute("PUT", "/api/project/:project/chat/sessions/:id/pin"),
  allowRoute("DELETE", "/api/project/:project/chat/sessions/:id/pin"),
  allowRoute("PATCH", "/api/project/:project/chat/sessions/:id/tag"),
  allowRoute("DELETE", "/api/project/:project/chat/sessions/:id/tag"),
  allowRoute("POST", "/api/project/:project/chat/sessions/:id/read"),
  allowRoute("POST", "/api/project/:project/chat/sessions/:id/unread"),
  allowRoute("GET", "/api/project/:project/tags"),
];

/** PPM's own records of a chat and its live state. */
export const realChatToolDeps: ChatToolDeps = {
  projects: () => projectService.list(),
  target: (project, sessionId) => resolveAssistantSessionTarget(project, sessionId),
  facts: async (sessionId) => {
    // Loaded on use: the manager table reaches the providers, which import the endpoint this family serves.
    const { managerChats } = await import("../assistant-managers/manager-chats.service.ts");
    const tag = getSessionTags([sessionId])[sessionId];
    return {
      title: watchedChatTitle(sessionId),
      pinned: getPinnedSessionIds().has(sessionId),
      tag: tag ? { id: tag.id, name: tag.name } : null,
      manager: managerChats.isManagerChat(sessionId),
      branched: hasChildren(sessionId),
    };
  },
  control: () => chatControl(),
  backgroundWork: async (sessionId) => (await import("../../server/ws/chat.ts")).hasBackgroundWork(sessionId),
  unattended: (sessionId) => isUnattendedTurn(sessionId),
  unpins: assistantRecentUnpins,
  now: () => Date.now(),
};

type DepsHandler = (ctx: ToolContext, args: Record<string, unknown>, deps: ChatToolDeps) => Promise<Json>;

/** A handler bound to `deps`, answering an unexpected failure as a tool error rather than a 500. */
const bind = (run: DepsHandler, deps: ChatToolDeps): FamilyHandler => async (ctx, args) => {
  try {
    return await run(ctx, args, deps);
  } catch (e) {
    return errorResult(`The chat tool failed: ${(e as Error).message}. Nothing more was done.`);
  }
};

/** The handlers over given dependencies; tests pass their own. */
export function createChatToolHandlers(deps: ChatToolDeps = realChatToolDeps): FamilyHandlers {
  return {
    [CHAT_STOP_TOOL]: bind(chatStop, deps),
    [CHAT_ORGANIZE_TOOL]: bind(chatOrganize, deps),
    [CHAT_DELETE_TOOL]: bind(chatDelete, deps),
  };
}

export const CHAT_TOOL_HANDLERS: FamilyHandlers = createChatToolHandlers();
