import { TERMINAL_TYPE_TOOL } from "../../shared/assistant-tool-names.ts";
import type { AssistantToolDefinition } from "./assistant-tool-family.ts";

/**
 * How `tools/list` describes `terminal_type` (handler: `assistant-terminal-type-tool.ts`). Kept on
 * leaf imports only: the tool list loads it while the services the handler needs are still loading.
 */

/** About two lines of a terminal: long enough for a real command, short enough to read whole. */
export const TERMINAL_TYPE_MAX_CHARS = 400;

const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object", properties, required, additionalProperties: false,
});

export const TERMINAL_TYPE_TOOL_DEFINITION: AssistantToolDefinition = {
  name: TERMINAL_TYPE_TOOL,
  title: "Type a command into a new terminal",
  description: "Open a new terminal in the dock of the project the user's device shows, its shell starting in a registered "
    + "project's folder, and type one shell command at its prompt for the user to run. Nothing runs until they press "
    + `Enter. One line of at most ${TERMINAL_TYPE_MAX_CHARS} characters, with no control or invisible characters; for more, `
    + "write a script file and type the command that runs it. The terminal keeps the AI-chat mark, so `ppm` run there "
    + "meets the rules for an AI chat. Follows the user's run_in_terminal switch (Settings → Tools). Refused in a turn "
    + "that came from Telegram, that PPM started, or that read text the user did not write: give them the command then.",
  inputSchema: object({
    project: { type: "string", description: "Name of a registered PPM project, as projects_list gives it: the shell starts in its folder." },
    command: { type: "string", minLength: 1, maxLength: TERMINAL_TYPE_MAX_CHARS, description: "The one-line shell command to type." },
    cwd: { type: "string", description: "A folder inside the project, relative to it (default: the project's folder)." },
  }, ["project", "command"]),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};
