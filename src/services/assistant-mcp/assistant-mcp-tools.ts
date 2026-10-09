import {
  CHAT_LIST_SESSIONS_TOOL, CHAT_READ_MESSAGES_TOOL, CHAT_SEARCH_TOOL, CHAT_SEND_MESSAGE_TOOL, DB_LIST_CONNECTIONS_TOOL, DB_QUERY_TOOL,
  PROJECTS_LIST_TOOL,
} from "../../shared/assistant-tool-names.ts";
import { UI_TOOL_DEFINITIONS } from "./assistant-ui-tools.ts";
import { UI_COMMAND_TOOL_DEFINITIONS, UI_NAV_TOOL_DEFINITIONS, UI_READ_TAB_DEFINITION } from "./assistant-ui-tool-definitions.ts";

/**
 * The tools the Assistant's MCP endpoint serves, and how long a call may take. The names each
 * provider knows them by are in `assistant-tool-names.ts`. Reading needs no approval; a call that
 * would change something (a database write, a message into a chat, closing a tab with unsaved
 * work, reading outside the registered projects) asks the user inside the endpoint first. The
 * tools that work on the user's screen are defined beside their handlers.
 */

export interface AssistantMcpAccess {
  url: string;
  token: string;
}

/** Environment variable the Codex app-server reads the bearer token from. */
export const CODEX_ASSISTANT_MCP_TOKEN_ENV = "PPM_ASSISTANT_MCP_TOKEN";

/**
 * The providers' own timeout for one call. Long, because a query may run for minutes and a call
 * that changes data waits for the user to approve it.
 */
export const ASSISTANT_MCP_TIMEOUT_MS = 12 * 60_000;
/** How long the endpoint keeps a call's connection open: past the providers' own timeout. */
export const ASSISTANT_MCP_HOLD_OPEN_SECONDS = ASSISTANT_MCP_TIMEOUT_MS / 1000 + 30;

export const MAX_SESSIONS_LISTED = 100;
export const MAX_SEARCH_RESULTS = 50;
export const MAX_MESSAGES_READ = 100;
export const MAX_CHAT_MESSAGE_CHARS = 20_000;

const PROJECT = { type: "string", description: "Name of a registered PPM project, as projects_list gives it." };
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

export const ASSISTANT_TOOL_DEFINITIONS = [
  {
    name: PROJECTS_LIST_TOOL,
    title: "List PPM projects",
    description: "List the projects registered in PPM, with their folders. Every other tool takes one of these names.",
    inputSchema: object({}),
    annotations: READ_ONLY,
  },
  {
    name: CHAT_LIST_SESSIONS_TOOL,
    title: "List a project's chats",
    description: "List a project's chat sessions, pinned first, then most recently active. `query` keeps only "
      + "chats whose title contains it; use chat_search to look inside the messages.",
    inputSchema: object({
      project: PROJECT,
      query: { type: "string", description: "Only chats whose title contains this text." },
      limit: { type: "integer", minimum: 1, maximum: MAX_SESSIONS_LISTED, description: "How many (default 30)." },
      offset: { type: "integer", minimum: 0, description: "How many to skip, for the next page." },
    }, ["project"]),
    annotations: READ_ONLY,
  },
  {
    name: CHAT_SEARCH_TOOL,
    title: "Search a project's chats",
    description: "Search a project's chats by title and message text. Each hit names its session id, provider "
      + "and a snippet; read the conversation with chat_read_messages.",
    inputSchema: object({
      project: PROJECT,
      query: { type: "string", minLength: 1, description: "Words to look for." },
      limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS, description: "How many hits (default 20)." },
    }, ["project", "query"]),
    annotations: READ_ONLY,
  },
  {
    name: CHAT_READ_MESSAGES_TOOL,
    title: "Read a chat",
    description: "Read the newest messages of one chat session in a project, oldest first. To read further back, "
      + "call again with `before` set to the `start` the previous answer gave.",
    inputSchema: object({
      project: PROJECT,
      sessionId: { type: "string", description: "The session id, from chat_list_sessions or chat_search." },
      providerId: { type: "string", enum: ["claude", "codex"], description: "The session's provider, when known." },
      limit: { type: "integer", minimum: 1, maximum: MAX_MESSAGES_READ, description: "How many messages (default 30)." },
      before: { type: "integer", minimum: 0, description: "Read the messages before this index." },
    }, ["project", "sessionId"]),
    annotations: READ_ONLY,
  },
  {
    name: DB_LIST_CONNECTIONS_TOOL,
    title: "List database connections",
    description: "List the database connections saved in PPM that the user made available to the AI: id, name, "
      + "engine, folder and whether it is read-only. Credentials are never shown.",
    inputSchema: object({}),
    annotations: READ_ONLY,
  },
  {
    name: DB_QUERY_TOOL,
    title: "Run a SQL query",
    description: "Run SQL on a saved connection and get its rows (at most 200, long values shortened) or how many "
      + "rows it changed. A query PPM can prove only reads (SELECT/WITH/SHOW/EXPLAIN calling ordinary functions: "
      + "aggregates, string, date, math, casts) runs at once on the read-only path. Anything else is shown to the user "
      + "in full and runs only if they approve; a read-only connection never runs a write.",
    inputSchema: object({
      connectionId: { type: ["integer", "string"], description: "The connection's id or name, from db_list_connections." },
      sql: { type: "string", minLength: 1, description: "The SQL to run." },
    }, ["connectionId", "sql"]),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  ...UI_TOOL_DEFINITIONS,
  ...UI_NAV_TOOL_DEFINITIONS,
  UI_READ_TAB_DEFINITION,
  ...UI_COMMAND_TOOL_DEFINITIONS,
  {
    name: CHAT_SEND_MESSAGE_TOOL,
    title: "Send a message into a chat",
    description: "Send a message into one of a project's chats, which then works on it as if the user had typed it. "
      + "Always asks the user first: the card shows the chat, the full message and the permission mode it will run in. "
      + "Refused for the Assistant's own chats and for a chat waiting on an approval of its own. Answers with the "
      + "session id; read the chat's reply later with chat_read_messages.",
    inputSchema: object({
      project: PROJECT,
      sessionId: { type: "string", description: "The chat's session id, from chat_list_sessions or chat_search." },
      providerId: { type: "string", enum: ["claude", "codex"], description: "The chat's provider, when known." },
      text: { type: "string", minLength: 1, maxLength: MAX_CHAT_MESSAGE_CHARS, description: "The message, exactly as it should be sent." },
    }, ["project", "sessionId", "text"]),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
] as const;
