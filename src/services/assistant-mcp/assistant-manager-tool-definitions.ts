import { MANAGER_ASSIGN_TOOL, MANAGER_UNASSIGN_TOOL } from "../../shared/assistant-manager-tool-names.ts";
import type { AssistantToolDefinition } from "./assistant-tool-family.ts";

/**
 * How the manager-chat tools are described to the agent, in the order of `MANAGER_TOOLS`.
 * Definitions only, so the tool list can be built without loading what the tools reach (handlers:
 * `assistant-manager-tools.ts`).
 */

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

const PROJECT = { type: "string", description: "Name of a registered PPM project, as projects_list gives it." };

export const MANAGER_TOOL_DEFINITIONS: readonly AssistantToolDefinition[] = [
  {
    name: MANAGER_ASSIGN_TOOL,
    title: "Make an existing chat the project's manager chat",
    description: "Make one of a project's existing chats its manager chat: the chat you then message without a card, "
      + "also while the user is away. Prefer this to creating a new manager chat when the user points at a chat they "
      + "already use. Always asks the user first; the card shows the chat, its mode and what the role allows. "
      + "Refused, before asking, for a chat of another project, a PPM Assistant or design chat, a Codex chat (manager "
      + "chats run on Claude), and while the project already has a manager chat unless `replace: true` (the card then "
      + "names the chat that stops being the manager). The user can do the same from the chat's menu: \"Set as manager chat\".",
    inputSchema: object({
      project: PROJECT,
      sessionId: { type: "string", description: "The chat's session id, from chat_list_sessions or chat_search." },
      providerId: { type: "string", enum: ["claude", "codex"], description: "The chat's provider, when known." },
      replace: { type: "boolean", description: "Take the role from the project's current manager chat (default false)." },
    }, ["project", "sessionId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: MANAGER_UNASSIGN_TOOL,
    title: "Stop a chat being the project's manager chat",
    description: "Take the manager-chat role away from a project's manager chat. The chat itself is kept, with its "
      + "history and mode; you then message it only with a card, like any other chat. Always asks the user first; "
      + "refused when the project has no manager chat. The user can do the same from the chat's menu: \"Unset manager chat\".",
    inputSchema: object({ project: PROJECT }, ["project"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];
