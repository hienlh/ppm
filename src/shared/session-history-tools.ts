/**
 * The AI's session-history tools, served by the tab-tools MCP server (`ppm-tabs`) beside the tab
 * and terminal tools: search the project's chats, outline one session's turns, read chosen turns.
 * Read-only; another project's turns are readable only when the person sent their links.
 */
export const SEARCH_SESSIONS_TOOL = "search_sessions";
export const LIST_SESSION_TURNS_TOOL = "list_session_turns";
export const READ_SESSION_TURNS_TOOL = "read_session_turns";

export const SESSION_HISTORY_TOOLS = [SEARCH_SESSIONS_TOOL, LIST_SESSION_TURNS_TOOL, READ_SESSION_TURNS_TOOL] as const;
export type SessionHistoryTool = (typeof SESSION_HISTORY_TOOLS)[number];

export const isSessionHistoryTool = (name: string): name is SessionHistoryTool =>
  (SESSION_HISTORY_TOOLS as readonly string[]).includes(name);
