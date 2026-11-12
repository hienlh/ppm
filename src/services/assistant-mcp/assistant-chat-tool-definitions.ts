import { CHAT_DELETE_TOOL, CHAT_ORGANIZE_TOOL, CHAT_STOP_TOOL } from "../../shared/assistant-chat-tool-names.ts";
import type { AssistantToolDefinition } from "./assistant-tool-family.ts";

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
];
