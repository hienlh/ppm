/**
 * The PPM Assistant's own MCP tools, served by `/api/assistant-mcp` to an Assistant session's
 * agent, and the names each provider knows them by. Claude addresses MCP tools as
 * `mcp__<server>__<tool>`; Codex takes the server name from its config key, where a hyphen is
 * not a safe character, hence the separate name, and its tool cards read `<server>:<tool>`.
 */
import { GIT_TOOLS } from "./assistant-git-tool-names.ts";
import { SCHEDULE_TOOLS } from "./assistant-schedule-tool-names.ts";
import { TUNNEL_TOOLS } from "./assistant-tunnel-tool-names.ts";
import { PROJECT_TOOLS } from "./assistant-project-tool-names.ts";

export const PROJECTS_LIST_TOOL = "projects_list";
export const PROJECT_ADD_TOOL = "project_add";
export const CHAT_LIST_SESSIONS_TOOL = "chat_list_sessions";
export const CHAT_SEARCH_TOOL = "chat_search";
export const CHAT_READ_MESSAGES_TOOL = "chat_read_messages";
export const DB_LIST_CONNECTIONS_TOOL = "db_list_connections";
export const DB_QUERY_TOOL = "db_query";
export const UI_GET_STATE_TOOL = "ui_get_state";
export const UI_OPEN_TAB_TOOL = "ui_open_tab";
export const UI_FOCUS_TAB_TOOL = "ui_focus_tab";
export const UI_SWITCH_PROJECT_TOOL = "ui_switch_project";
export const UI_CLOSE_TAB_TOOL = "ui_close_tab";
export const UI_READ_TAB_TOOL = "ui_read_tab";
export const UI_LIST_COMMANDS_TOOL = "ui_list_commands";
export const UI_RUN_COMMAND_TOOL = "ui_run_command";
export const CHATS_ATTENTION_TOOL = "chats_attention";
export const CHAT_ANSWER_APPROVAL_TOOL = "chat_answer_approval";
export const PPM_CLI_REFERENCE_TOOL = "ppm_cli_reference";
export const CHAT_WATCH_TOOL = "chat_watch";
export const CHAT_UNWATCH_TOOL = "chat_unwatch";
export const CHAT_LIST_WATCHES_TOOL = "chat_list_watches";
export const NOTEBOOK_ADD_TOOL = "notebook_add";
export const NOTEBOOK_EDIT_TOOL = "notebook_edit";
export const NOTEBOOK_DELETE_TOOL = "notebook_delete";

/**
 * Every tool the endpoint serves, in the order `tools/list` gives them. The git, schedule, tunnel
 * and project families keep their names in their own files and come last, in that order — the order
 * `ASSISTANT_TOOL_DEFINITIONS` spreads their definitions in. Opening and messaging the user's
 * chats is not here: the Assistant uses PPM's session tools (`ppm-sessions`) for that.
 */
export const ASSISTANT_TOOLS = [
  PROJECTS_LIST_TOOL, PROJECT_ADD_TOOL, CHAT_LIST_SESSIONS_TOOL, CHAT_SEARCH_TOOL, CHAT_READ_MESSAGES_TOOL,
  DB_LIST_CONNECTIONS_TOOL, DB_QUERY_TOOL, UI_GET_STATE_TOOL,
  UI_OPEN_TAB_TOOL, UI_FOCUS_TAB_TOOL, UI_SWITCH_PROJECT_TOOL, UI_CLOSE_TAB_TOOL, UI_READ_TAB_TOOL,
  UI_LIST_COMMANDS_TOOL, UI_RUN_COMMAND_TOOL,
  CHATS_ATTENTION_TOOL, CHAT_ANSWER_APPROVAL_TOOL, PPM_CLI_REFERENCE_TOOL,
  CHAT_WATCH_TOOL, CHAT_UNWATCH_TOOL, CHAT_LIST_WATCHES_TOOL,
  NOTEBOOK_ADD_TOOL, NOTEBOOK_EDIT_TOOL, NOTEBOOK_DELETE_TOOL,
  ...GIT_TOOLS, ...SCHEDULE_TOOLS, ...TUNNEL_TOOLS, ...PROJECT_TOOLS,
] as const;
export type AssistantToolName = (typeof ASSISTANT_TOOLS)[number];

export const CLAUDE_ASSISTANT_MCP_SERVER = "ppm-assistant";
/** Claude's name prefix for the Assistant's tools. */
export const CLAUDE_ASSISTANT_MCP_PREFIX = `mcp__${CLAUDE_ASSISTANT_MCP_SERVER}__`;
export const CODEX_ASSISTANT_MCP_SERVER = "ppm_assistant";

export const claudeAssistantToolName = (tool: AssistantToolName): string => `${CLAUDE_ASSISTANT_MCP_PREFIX}${tool}`;
