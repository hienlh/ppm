/**
 * The PPM Assistant's own MCP tools, served by `/api/assistant-mcp` to an Assistant session's
 * agent, and the names each provider knows them by. Claude addresses MCP tools as
 * `mcp__<server>__<tool>`; Codex takes the server name from its config key, where a hyphen is
 * not a safe character, hence the separate name, and its tool cards read `<server>:<tool>`.
 */
export const PROJECTS_LIST_TOOL = "projects_list";
export const CHAT_LIST_SESSIONS_TOOL = "chat_list_sessions";
export const CHAT_SEARCH_TOOL = "chat_search";
export const CHAT_READ_MESSAGES_TOOL = "chat_read_messages";
export const DB_LIST_CONNECTIONS_TOOL = "db_list_connections";
export const DB_QUERY_TOOL = "db_query";
export const UI_GET_STATE_TOOL = "ui_get_state";

/** Every tool the endpoint serves, in the order `tools/list` gives them. */
export const ASSISTANT_TOOLS = [
  PROJECTS_LIST_TOOL, CHAT_LIST_SESSIONS_TOOL, CHAT_SEARCH_TOOL, CHAT_READ_MESSAGES_TOOL,
  DB_LIST_CONNECTIONS_TOOL, DB_QUERY_TOOL, UI_GET_STATE_TOOL,
] as const;
export type AssistantToolName = (typeof ASSISTANT_TOOLS)[number];

export const CLAUDE_ASSISTANT_MCP_SERVER = "ppm-assistant";
/** Claude's name prefix for the Assistant's tools. */
export const CLAUDE_ASSISTANT_MCP_PREFIX = `mcp__${CLAUDE_ASSISTANT_MCP_SERVER}__`;
export const CODEX_ASSISTANT_MCP_SERVER = "ppm_assistant";

export const claudeAssistantToolName = (tool: AssistantToolName): string => `${CLAUDE_ASSISTANT_MCP_PREFIX}${tool}`;
