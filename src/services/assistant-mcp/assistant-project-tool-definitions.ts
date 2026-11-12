import { PROJECT_REMOVE_TOOL, PROJECT_UPDATE_TOOL } from "../../shared/assistant-project-tool-names.ts";
import type { AssistantToolDefinition } from "./assistant-tool-family.ts";

/**
 * How the project tools are described to the agent, in the order of `PROJECT_TOOLS`. Definitions
 * only, so the tool list can be built without loading what the tools reach (handlers:
 * `assistant-project-tools.ts`).
 */

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

const PROJECT = { type: "string", description: "Name of a registered PPM project, as projects_list gives it." };

export const PROJECT_TOOL_DEFINITIONS: readonly AssistantToolDefinition[] = [
  {
    name: PROJECT_UPDATE_TOOL,
    title: "Rename, move or recolour a project",
    description: "Change a registered project: rename it (`name`), point it at another folder (`path`; the old folder is "
      + "left as it is), or set its colour (`color`, #rrggbb, or null to clear). Give only what changes. Always asks the "
      + "user first. A move is refused, before asking, for a drive, the home folder or anything holding it, PPM's own "
      + "data folder and folders where applications keep logins (~/.config, AppData…), and while the project's manager "
      + "chat is running a turn. The Assistant's own chats are not a project.",
    inputSchema: object({
      project: PROJECT,
      name: { type: "string", minLength: 1, maxLength: 100, description: "The new name." },
      path: { type: "string", minLength: 1, description: "The new folder's full path; it must exist." },
      color: { type: ["string", "null"], description: "#rrggbb, or null to clear the colour." },
    }, ["project"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: PROJECT_REMOVE_TOOL,
    title: "Remove a project from PPM",
    description: "Take a project out of PPM. Its files on disk and its chat transcripts stay; PPM forgets the project and "
      + "deletes its Jira settings, watchers and what they found. Always asks the user first; refused while the "
      + "project's manager chat is running a turn. The Assistant's own chats are not a project.",
    inputSchema: object({ project: PROJECT }, ["project"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
];
