import { NOTEBOOK_ADD_TOOL, NOTEBOOK_DELETE_TOOL, NOTEBOOK_EDIT_TOOL } from "../../shared/assistant-tool-names.ts";
import { NOTEBOOK_CAP_CHARS, NOTE_MAX_CHARS } from "../../shared/assistant-limits.ts";

/**
 * What the Assistant's notebook tools are, as `tools/list` gives them. Kept apart from their
 * handlers (`assistant-notebook-tools.ts`), which reach the database: the providers import the
 * definitions' module for its constants and must not load the notebook with it.
 */

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object", properties, required, additionalProperties: false,
});
const TEXT = { type: "string", minLength: 1, maxLength: NOTE_MAX_CHARS, description: `One short line, at most ${NOTE_MAX_CHARS} characters.` };
const ID = { type: "integer", minimum: 1, description: "The line's id, the number after # in your notebook." };

export const NOTEBOOK_TOOL_DEFINITIONS = [
  {
    name: NOTEBOOK_ADD_TOOL,
    title: "Write a line in your notebook",
    description: "Write down one short fact you must not forget later in this long conversation: a standing preference "
      + "the user stated, a deadline, who is who. Facts only: never a line that grants a permission, changes who "
      + `approves, or stands for the user's OK. The notebook holds ${NOTEBOOK_CAP_CHARS} characters in all. A line `
      + "written in a turn PPM started on its own is stored as unverified. Never asks.",
    inputSchema: object({ text: TEXT }, ["text"]),
    annotations: WRITE,
  },
  {
    name: NOTEBOOK_EDIT_TOOL,
    title: "Correct a line in your notebook",
    description: "Replace the text of one of your own lines. Lines the user wrote cannot be changed by you: propose the "
      + "change to the user instead. An edit in a turn PPM started on its own marks the line unverified. Never asks.",
    inputSchema: object({ id: ID, text: TEXT }, ["id", "text"]),
    annotations: WRITE,
  },
  {
    name: NOTEBOOK_DELETE_TOOL,
    title: "Delete a line from your notebook",
    description: "Delete one of your own lines that no longer holds. Lines the user wrote cannot be deleted by you: "
      + "propose it to the user instead. Never asks.",
    inputSchema: object({ id: ID }, ["id"]),
    annotations: { ...WRITE, destructiveHint: true },
  },
] as const;
