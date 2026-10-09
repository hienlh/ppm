import { createMcpHttpHandler, type Json } from "../mcp-http-endpoint.ts";
import { isAssistantSession } from "../assistant/assistant-session.ts";
import { resolveMigratedSession } from "../db.service.ts";
import {
  CHAT_LIST_SESSIONS_TOOL, CHAT_READ_MESSAGES_TOOL, CHAT_SEARCH_TOOL, CHAT_SEND_MESSAGE_TOOL, CLAUDE_ASSISTANT_MCP_SERVER, DB_LIST_CONNECTIONS_TOOL,
  DB_QUERY_TOOL, PROJECTS_LIST_TOOL, UI_CLOSE_TAB_TOOL, UI_FOCUS_TAB_TOOL, UI_GET_STATE_TOOL, UI_OPEN_TAB_TOOL,
  UI_LIST_COMMANDS_TOOL, UI_READ_TAB_TOOL, UI_RUN_COMMAND_TOOL, UI_SWITCH_PROJECT_TOOL,
} from "../../shared/assistant-tool-names.ts";
import { ASSISTANT_MCP_HOLD_OPEN_SECONDS, ASSISTANT_TOOL_DEFINITIONS } from "./assistant-mcp-tools.ts";
import { assistantMcpTokens, type AssistantMcpTokenBinding } from "./assistant-mcp-tokens.ts";
import { chatListSessions, chatReadMessages, chatSearch, projectsList } from "./assistant-read-tools.ts";
import { dbListConnections, dbQuery } from "./assistant-db-tools.ts";
import { errorResult } from "./assistant-tool-output.ts";
import { uiGetState } from "./assistant-ui-tools.ts";
import { uiCloseTab, uiFocusTab, uiOpenTab, uiSwitchProject } from "./assistant-ui-nav-tools.ts";
import { uiReadTab } from "./assistant-ui-read-tool.ts";
import { uiListCommands, uiRunCommand } from "./assistant-ui-command-tools.ts";
import { approvalAskerFor } from "./assistant-approval-broker.ts";
import { chatSendMessage } from "./assistant-chat-send.ts";

/**
 * `/api/assistant-mcp` — the PPM Assistant's own tools, for one Assistant session's agent (the
 * MCP plumbing is `mcp-http-endpoint.ts`). Mounted before PPM's auth: the caller is a Claude or
 * Codex subprocess, and its per-session token is the whole credential. A token is honoured only
 * while its session is still an Assistant session — checked on every request, following a
 * provider's rename of the id — so a token that outlives its session, or one minted for an
 * ordinary chat, reaches nothing.
 */

type ToolCall = (binding: AssistantMcpTokenBinding, name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<Json>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function createAssistantMcpHandler(deps: {
  resolveToken: (token: string | null) => AssistantMcpTokenBinding | null;
  isAssistant: (sessionId: string) => boolean;
  callTool: ToolCall;
}) {
  return createMcpHttpHandler<AssistantMcpTokenBinding>({
    serverName: CLAUDE_ASSISTANT_MCP_SERVER,
    tokenRequired: "A PPM Assistant session token is required",
    resolveToken: (token) => {
      const binding = deps.resolveToken(token);
      return binding && deps.isAssistant(binding.sessionId) ? binding : null;
    },
    tools: ASSISTANT_TOOL_DEFINITIONS,
    holdOpenSeconds: ASSISTANT_MCP_HOLD_OPEN_SECONDS,
    callTool: (binding, name, args, signal) => deps.callTool(binding, name, isObj(args) ? args : {}, signal),
  });
}

/**
 * Runs one of the Assistant's tools for the session `binding` names. A tool that may change
 * something asks the user through `ask`, bound to this session and to this HTTP call: the
 * provider closing the call withdraws the question.
 */
export const callAssistantTool: ToolCall = async ({ sessionId }, name, args, signal) => {
  const ask = approvalAskerFor(sessionId, signal);
  switch (name) {
    case PROJECTS_LIST_TOOL: return projectsList();
    case CHAT_LIST_SESSIONS_TOOL: return chatListSessions(args);
    case CHAT_SEARCH_TOOL: return chatSearch(args);
    case CHAT_READ_MESSAGES_TOOL: return chatReadMessages(args);
    case CHAT_SEND_MESSAGE_TOOL: return chatSendMessage(args, ask);
    case DB_LIST_CONNECTIONS_TOOL: return dbListConnections();
    case DB_QUERY_TOOL:
      return dbQuery(args, { actor: "agent", callerIp: null, callerUa: `PPM Assistant (session ${sessionId})` }, ask, undefined, { signal });
    case UI_GET_STATE_TOOL: return uiGetState(sessionId);
    case UI_OPEN_TAB_TOOL: return uiOpenTab(sessionId, args);
    case UI_FOCUS_TAB_TOOL: return uiFocusTab(sessionId, args);
    case UI_SWITCH_PROJECT_TOOL: return uiSwitchProject(sessionId, args);
    case UI_CLOSE_TAB_TOOL: return uiCloseTab(sessionId, args, ask);
    case UI_READ_TAB_TOOL: return uiReadTab(sessionId, args, ask);
    case UI_LIST_COMMANDS_TOOL: return uiListCommands(sessionId, args);
    case UI_RUN_COMMAND_TOOL: return uiRunCommand(sessionId, args, ask);
    default: return errorResult(`Unknown tool: ${name.slice(0, 60)}`);
  }
};

/**
 * Judged by the id the session goes by now: Codex renames a new chat during its first turn,
 * after the token was minted under the old id, and deleting the renamed session removes only
 * the new id's row — the old one, still marked, must not keep the token alive.
 */
export function isLiveAssistantSession(sessionId: string): boolean {
  return isAssistantSession(resolveMigratedSession(sessionId));
}

export const assistantMcpHandler = createAssistantMcpHandler({
  resolveToken: (token) => assistantMcpTokens.resolve(token),
  isAssistant: isLiveAssistantSession,
  callTool: callAssistantTool,
});
