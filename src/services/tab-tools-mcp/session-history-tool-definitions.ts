import {
  LIST_SESSION_TURNS_TOOL, READ_SESSION_TURNS_TOOL, SEARCH_SESSIONS_TOOL,
} from "../../shared/session-history-tools.ts";

/**
 * The session-history tools as `tools/list` describes them. Each description says when to call
 * the tool, because an agent uses a tool only when it knows the moment it is for.
 */

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 20;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
/** Turns one read may name or span. */
export const MAX_READ_TURNS = 10;

const SESSION_ID = { type: "string", description: "The session's id, as search_sessions, list_session_turns or a turn link gave it." };

export const SEARCH_SESSIONS_TOOL_DEFINITION = {
  name: SEARCH_SESSIONS_TOOL,
  title: "Search this project's chats",
  description:
    "Search the titles and the prompt and answer text of this project's earlier chat sessions (Claude and Codex). "
    + "Call it when the user mentions something discussed or decided in another chat (\"where we talked about X\", "
    + "\"the fix from last week\") instead of asking them to find it. Each content match names its session and turn; "
    + "read the turn with read_session_turns. It does not search what tools printed, and it reads only what PPM has "
    + "already indexed: the answer says when that index is incomplete.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to look for; every word must match (prefix match)." },
      limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_LIMIT, description: `Content matches to return (default ${DEFAULT_SEARCH_LIMIT}).` },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export const LIST_SESSION_TURNS_TOOL_DEFINITION = {
  name: LIST_SESSION_TURNS_TOOL,
  title: "List a chat's turns",
  description:
    "List the turns of one of this project's chat sessions: number, turn id, time, status and the first line of "
    + "each prompt, newest last. Call it when you know the session but not the turn, then read the turns you need "
    + `with read_session_turns. Shows the last ${DEFAULT_LIST_LIMIT} turns; pass offset to page back to older ones.`,
  inputSchema: {
    type: "object",
    properties: {
      session_id: SESSION_ID,
      offset: { type: "integer", minimum: 0, description: "Turns to skip, counted back from the newest (default 0)." },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIST_LIMIT, description: `Turns to list (default ${DEFAULT_LIST_LIMIT}).` },
    },
    required: ["session_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export const READ_SESSION_TURNS_TOOL_DEFINITION = {
  name: READ_SESSION_TURNS_TOOL,
  title: "Read turns of a chat",
  description:
    "Read 1 to 10 turns of a chat session: the prompt, the assistant's answers and one line per tool call (no tool "
    + "output, no thinking). Call it when the user sends a turn link, or after search_sessions or list_session_turns "
    + "found the turn you need — read the turn rather than guessing what was said. Pass turn_ids, or from_turn and "
    + "to_turn as turn numbers. A session of another project can be read only for the exact turns the user sent links "
    + "to in this chat: pass those turn_ids (and the project named in the link).",
  inputSchema: {
    type: "object",
    properties: {
      session_id: SESSION_ID,
      turn_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_READ_TURNS, description: "Turn ids to read." },
      from_turn: { type: "integer", minimum: 1, description: "First turn number of a range (this project's sessions only)." },
      to_turn: { type: "integer", minimum: 1, description: `Last turn number of the range; at most ${MAX_READ_TURNS} turns.` },
      project: { type: "string", description: "The project a turn link named, when it is not this chat's project." },
    },
    required: ["session_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export const SESSION_HISTORY_TOOL_DEFINITIONS = [
  SEARCH_SESSIONS_TOOL_DEFINITION, LIST_SESSION_TURNS_TOOL_DEFINITION, READ_SESSION_TURNS_TOOL_DEFINITION,
];
