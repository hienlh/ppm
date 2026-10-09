import {
  CHAT_LIST_SESSIONS_TOOL, CHAT_READ_MESSAGES_TOOL, CHAT_SEARCH_TOOL, DB_LIST_CONNECTIONS_TOOL, DB_QUERY_TOOL,
  PROJECTS_LIST_TOOL,
} from "../../shared/assistant-tool-names.ts";
import { UI_TOOL_DEFINITIONS } from "./assistant-ui-tools.ts";
import { UI_NAV_TOOL_DEFINITIONS, UI_READ_TAB_DEFINITION } from "./assistant-ui-tool-definitions.ts";

/**
 * The tools the Assistant's MCP endpoint serves, and how long a call may take. The names each
 * provider knows them by are in `assistant-tool-names.ts`. Every tool here only reads; the ones that
 * read the user's screen are defined beside their handler in `assistant-ui-tools.ts`.
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
    title: "Run a read query",
    description: "Run one read-only SQL query on a saved connection and get its rows (at most 200, long values "
      + "shortened). Only a query PPM can prove only reads runs here: SELECT/WITH/SHOW/EXPLAIN calling ordinary "
      + "functions (aggregates, string, date, math, casts). Anything else is not run; the answer says why.",
    inputSchema: object({
      connectionId: { type: ["integer", "string"], description: "The connection's id or name, from db_list_connections." },
      sql: { type: "string", minLength: 1, description: "The query." },
    }, ["connectionId", "sql"]),
    annotations: READ_ONLY,
  },
  ...UI_TOOL_DEFINITIONS,
  ...UI_NAV_TOOL_DEFINITIONS,
  UI_READ_TAB_DEFINITION,
] as const;
