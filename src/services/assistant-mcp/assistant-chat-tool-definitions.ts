import {
  CHAT_CHANGES_ANSWER_TOOL, CHAT_CHANGES_TOOL, CHAT_DELETE_TOOL, CHAT_ORGANIZE_TOOL, CHAT_STOP_TOOL,
} from "../../shared/assistant-chat-tool-names.ts";
import type { AssistantToolDefinition } from "./assistant-tool-family.ts";
import { DEFAULT_TURN_LIMIT } from "../session-file-baselines/session-turn-calls.ts";

/** Lines of one file's diff `chat_changes` returns. */
export const MAX_REVIEW_DIFF_LINES = 400;
/** Files one `chat_changes_answer` call may name. */
export const MAX_REVIEW_FILES = 100;

/**
 * How the chat tools are described to the agent, in the order of `CHAT_TOOLS`. Definitions only,
 * so the tool list can be built without loading what the tools reach (handlers:
 * `assistant-chat-tools.ts`).
 */

/** How many chats one `chat_organize` call may change; one card covers them all. */
export const MAX_ORGANIZE_CHANGES = 20;
export const MAX_CHAT_TITLE_CHARS = 200;

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

const PROJECT = { type: "string", description: "Name of a registered PPM project, as projects_list gives it." };
const SESSION = { type: "string", description: "The chat's session id, from chat_list_sessions, chat_search or chats_attention." };

export const CHAT_TOOL_DEFINITIONS: readonly AssistantToolDefinition[] = [
  {
    name: CHAT_STOP_TOOL,
    title: "Stop a chat's running turn",
    description: "Stop the turn a project's chat is running, as PPM's Stop button does. What it already wrote stays; work "
      + "in progress, and its background agents and shells, stop. Always asks the user first. Refused, before asking, when "
      + "the chat is not running. Stops only the turn the card showed: if that turn ends while the card waits, nothing is "
      + "stopped. The Assistant's own chats are not a target.",
    inputSchema: object({ project: PROJECT, sessionId: SESSION }, ["project", "sessionId"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: CHAT_ORGANIZE_TOOL,
    title: "Rename, pin, tag or mark chats read",
    description: `Organise up to ${MAX_ORGANIZE_CHANGES} of a project's chats in one call: a new \`title\`, \`pinned\` true or `
      + "false, `tag` (a tag's name in that project, or null to remove it), `read` true or false. Give only what changes. "
      + "Runs at once when the user started this turn and nothing they did not write has reached it yet (no chat titles, "
      + "files, tabs or other outside text read in this turn); otherwise the user approves the whole call on one card. "
      + "Refused in a turn PPM started on its own. Marking a chat read is refused while it waits for the user on a card; "
      + "a manager chat's title is left to the user.",
    inputSchema: object({
      project: PROJECT,
      changes: {
        type: "array", minItems: 1, maxItems: MAX_ORGANIZE_CHANGES,
        items: object({
          sessionId: SESSION,
          title: { type: "string", minLength: 1, maxLength: MAX_CHAT_TITLE_CHARS, description: "The new title." },
          pinned: { type: "boolean", description: "Pin (true) or unpin (false)." },
          tag: { type: ["string", "null"], description: "A tag's name in the project, or null to remove the chat's tag." },
          read: { type: "boolean", description: "Mark read (true) or unread (false)." },
        }, ["sessionId"]),
      },
    }, ["project", "changes"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: CHAT_DELETE_TOOL,
    title: "Delete a chat",
    description: "Delete one of a project's chats: its transcript and PPM's records of it. This cannot be undone. Always "
      + "asks the user first; the card says when the chat is pinned. A running chat is stopped first, and nothing is "
      + "deleted if it does not stop. Refused for a project's manager chat and for a chat with edited versions branched "
      + "from it. The Assistant's own chats are not a target.",
    inputSchema: object({ project: PROJECT, sessionId: SESSION }, ["project", "sessionId"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: CHAT_CHANGES_TOOL,
    title: "Read the files a chat changed",
    description: "The files one of a project's chats changed on disk, as its Review tab lists them: each file's path, "
      + "lines added and removed, how many of its change blocks are still open, and whether the user marked it reviewed; "
      + `with the chat's newest ${DEFAULT_TURN_LIMIT} turns (number, time, the prompt's start, how many calls). Give \`path\` `
      + `(one of the listed files) for that file's blocks — key, lines, the turns that wrote them — and its diff (at most `
      + `${MAX_REVIEW_DIFF_LINES} lines). Reads only; the file contents it returns are text the user did not write.`,
    inputSchema: object({
      project: PROJECT, sessionId: SESSION,
      path: { type: "string", description: "One file from this tool's list, as listed (absolute) or relative to the project." },
    }, ["project", "sessionId"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: CHAT_CHANGES_ANSWER_TOOL,
    title: "Keep, reopen, revert or undo a chat's file changes",
    description: "Answer a chat's file changes as its Review tab does. `keep` accepts the changes of `files` (all listed "
      + "files when omitted); it runs at once when the user started this turn and no outside text has reached it, "
      + "otherwise one card covers the call. `reopen` opens kept changes again, without a card. `revert` puts `files` "
      + "(required) back as they were before the chat changed them; `revert_turn` puts back what turn `turn` changed "
      + `(one of the newest ${DEFAULT_TURN_LIMIT} turns); \`undo\` takes back an earlier answer by its \`undoId\`. Those three `
      + "write files and always ask. A file that changed since it was shown is left alone (stale). Every answer that did "
      + "something returns an `undoId`. Refused in a turn PPM started on its own. Name blocks by the keys chat_changes gives.",
    inputSchema: object({
      project: PROJECT, sessionId: SESSION,
      action: { type: "string", enum: ["keep", "reopen", "revert", "undo", "revert_turn"] },
      files: {
        type: "array", minItems: 1, maxItems: MAX_REVIEW_FILES,
        items: object({
          path: { type: "string", description: "A file from chat_changes." },
          blocks: { type: "array", minItems: 1, items: { type: "string" }, description: "Only these blocks (keys from chat_changes); every block when omitted." },
        }, ["path"]),
      },
      turn: { type: "integer", minimum: 1, description: "revert_turn: the turn's number, from chat_changes." },
      undoId: { type: "string", description: "undo: the undoId an earlier answer returned." },
    }, ["project", "sessionId", "action"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];
