import {
  CHAT_ANSWER_APPROVAL_TOOL, CHAT_LIST_SESSIONS_TOOL, CHAT_READ_MESSAGES_TOOL, CHAT_SEARCH_TOOL, CHAT_SEND_MESSAGE_TOOL, CHAT_START_TOOL,
  CHATS_ATTENTION_TOOL, DB_LIST_CONNECTIONS_TOOL, DB_QUERY_TOOL, PPM_CLI_REFERENCE_TOOL, PROJECTS_LIST_TOOL,
  CHAT_WATCH_TOOL, CHAT_UNWATCH_TOOL, CHAT_LIST_WATCHES_TOOL,
} from "../../shared/assistant-tool-names.ts";
import { UI_TOOL_DEFINITIONS } from "./assistant-ui-tools.ts";
import { MAX_ACTIVE_WATCHES, NOTIFY_KINDS } from "../assistant-watch/watch-state.ts";
import { UI_COMMAND_TOOL_DEFINITIONS, UI_NAV_TOOL_DEFINITIONS, UI_READ_TAB_DEFINITION } from "./assistant-ui-tool-definitions.ts";

/**
 * The tools the Assistant's MCP endpoint serves, and how long a call may take. The names each
 * provider knows them by are in `assistant-tool-names.ts`. Reading needs no approval; a call that
 * would change something (a database write, a message into a chat, closing a tab with unsaved
 * work) or read a tab's content from outside the registered projects asks the user inside the
 * endpoint first. The
 * tools that work on the user's screen are defined beside their handlers.
 */

export interface AssistantMcpAccess {
  url: string;
  token: string;
}

/** Environment variable the Codex app-server reads the bearer token from. */
export const CODEX_ASSISTANT_MCP_TOKEN_ENV = "PPM_ASSISTANT_MCP_TOKEN";

/**
 * The providers' own timeout for one call: the longest either holds, because a call that changes
 * data waits for the user's approval for as long as the user takes (until PPM restarts), and an
 * approved query is the user's to run to the end. About 24.8 days, not "no limit", because
 * neither provider offers one: Claude clamps a server's `timeout` to 2^31 − 1 ms (the longest a
 * JS timer holds), and leaving it unset is worse — an HTTP server's call is then cut after five
 * minutes without a byte, which a waiting approval never sends. Codex's `tool_timeout_sec` gets
 * the same figure in seconds.
 */
export const ASSISTANT_MCP_TIMEOUT_MS = 2_147_483_647;
/**
 * How long the endpoint lets a call's connection stay silent, in Bun's `server.timeout` seconds:
 * 0 lifts its idle limit for that request (measured: a request held 5 s past a 2 s idle limit
 * still answered), so a call is ended only by its answer or by the caller closing it.
 */
export const ASSISTANT_MCP_HOLD_OPEN_SECONDS = 0;

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
  {
    name: CHATS_ATTENTION_TOOL,
    title: "What needs the user",
    description: "Overview of the user's chats across projects, open or not: cards waiting for an answer (with what "
      + "each would run), chats running, cards lost to a restart, chats stopped on an error, finished chats not yet "
      + "read, and finished ones already read. Each group lists at most 20. Never asks.",
    inputSchema: object({
      project: { ...PROJECT, description: "Only this project's chats." },
      since: { type: "string", description: "Finished and stopped chats from \"today\" (default) or the last hours, e.g. \"6h\" (up to 168h)." },
    }),
    annotations: READ_ONLY,
  },
  {
    name: CHAT_START_TOOL,
    title: "Start a new chat",
    description: "Open a new chat in a project and send it a first message, which it then works on as if the user "
      + "had typed it. Always asks the user first; the card shows the project, provider, model, the permission mode "
      + "it runs in and the full message. Without `permissionMode` the chat gets the mode a new chat gets in PPM "
      + "(often bypass, which runs every tool unasked); suggest a safer mode when the user did not say. Answers "
      + "with the new session id.",
    inputSchema: object({
      project: PROJECT,
      text: { type: "string", minLength: 1, maxLength: MAX_CHAT_MESSAGE_CHARS, description: "The first message, exactly as it should be sent." },
      providerId: { type: "string", enum: ["claude", "codex"], description: "The chat's provider (default: PPM's default provider)." },
      model: { type: "string", description: "A model id for the chat; the provider's default when absent." },
      permissionMode: { type: "string", enum: ["default", "acceptEdits", "plan", "bypassPermissions"], description: "The mode the chat runs in." },
      title: { type: "string", maxLength: 200, description: "A title for the chat." },
      watch: { type: "boolean", description: "Also watch the new chat, as chat_watch does: you are woken to report when its run ends." },
    }, ["project", "text"]),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: CHAT_ANSWER_APPROVAL_TOOL,
    title: "Answer another chat's card",
    description: "Answer the card a chat is waiting on (take the ids from chats_attention). Always asks the user first, "
      + "denying included; the confirmation repeats exactly what the card would run. A question card is answered with "
      + "`answersById` (question id → list of chosen option labels or typed text; one entry unless the question allows "
      + "several); `deny` skips it. A card PPM cannot show in full here can only be denied.",
    inputSchema: object({
      project: PROJECT,
      sessionId: { type: "string", description: "The chat's session id." },
      requestId: { type: "string", description: "The waiting card's id." },
      decision: { type: "string", enum: ["allow", "deny"], description: "Allow (or answer) the card, or deny (or skip) it." },
      answersById: { type: "object", additionalProperties: { type: "array", items: { type: "string" } }, description: "A question card's answers." },
    }, ["project", "sessionId", "requestId", "decision"]),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  {
    name: PPM_CLI_REFERENCE_TOOL,
    title: "PPM CLI reference",
    description: "How to run the `ppm` command line against this PPM, which commands go through the running server and "
      + "which change its data directly, and every command with its options. For what PPM's own tools do not cover "
      + "(git, schedules, tunnels, extensions). Running a command is a shell call, which asks the user.",
    inputSchema: object({}),
    annotations: READ_ONLY,
  },
  {
    name: CHAT_WATCH_TOOL,
    title: "Watch a chat",
    description: "Ask PPM to tell you when one of a project's chats finishes its run: when it ends (finished, stopped "
      + "by an error, or cut off by a PPM restart) PPM wakes this conversation for a short report, even after a "
      + "restart. While watched, the chat's approval cards and questions always go to the user directly, whatever "
      + "`notifyOn` says, and never wake you. A chat that already finished after "
      + "the user asked is reported at once instead; an idle chat is watched through its next run. Expires after 24 "
      + `hours; at most ${MAX_ACTIVE_WATCHES} at a time. Never asks.`,
    inputSchema: object({
      project: PROJECT,
      sessionId: { type: "string", description: "The chat's session id." },
      providerId: { type: "string", enum: ["claude", "codex"], description: "The chat's provider, when known." },
      notifyOn: {
        type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: [...NOTIFY_KINDS] },
        description: "Which ends of the run wake you for a report (default both): `done` a finished run, `stopped` one ended by an "
          + "error or a restart. It does not affect the chat's approval cards, which always go to the user.",
      },
    }, ["project", "sessionId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: CHAT_UNWATCH_TOOL,
    title: "Stop watching a chat",
    description: "Stop a watch this conversation set, including news it has not reported yet. Never asks.",
    inputSchema: object({
      watchId: { type: "string", description: "The watch's id, from chat_watch or chat_list_watches." },
    }, ["watchId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: CHAT_LIST_WATCHES_TOOL,
    title: "List watched chats",
    description: "The chats this conversation watches, with what happened to each: watching, reported, or waiting to be reported.",
    inputSchema: object({}),
    annotations: READ_ONLY,
  },
] as const;
