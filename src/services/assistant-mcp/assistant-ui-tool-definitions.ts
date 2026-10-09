import {
  UI_CLOSE_TAB_TOOL, UI_FOCUS_TAB_TOOL, UI_OPEN_TAB_TOOL, UI_READ_TAB_TOOL, UI_SWITCH_PROJECT_TOOL,
} from "../../shared/assistant-tool-names.ts";
import { ASSISTANT_TAB_KINDS } from "../../shared/assistant-ui-protocol.ts";
import {
  READ_TAB_CHAT_MESSAGES, READ_TAB_DB_ROWS, READ_TAB_MAX_LINES, READ_TAB_TERMINAL_LINES,
} from "../../shared/assistant-tab-content.ts";

/**
 * How the Assistant's screen tools are described to the agent: the ones that move around the
 * screen and the one that reads a tab. Definitions only, so the tool list can be built without
 * loading what the tools reach (handlers: `assistant-ui-nav-tools.ts`, `assistant-ui-read-tool.ts`).
 */

const NAV = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const PROJECT = { type: "string", description: "Name of a registered PPM project, as projects_list gives it." };
const TAB_ID = { type: "string", description: "The tab's id, from ui_get_state." };
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object", properties, required, additionalProperties: false,
});

export const UI_NAV_TOOL_DEFINITIONS = [
  {
    name: UI_OPEN_TAB_TOOL,
    title: "Open a tab",
    description: "Open a tab on the device the user is chatting from, in `project` (switched to first when another "
      + "project is showing), beside the Assistant. A tab already showing the same thing is brought forward instead. "
      + "`kind` and its `target` fields: chat — `sessionId` (+ `providerId`) of one of the project's chats, or none "
      + "for a new chat; terminal — none (a new terminal in the project's folder); database — `connectionId` (id or "
      + "name from db_list_connections) with `table` (+ `schema`, `database`) for its data, or without `table` for a new "
      + "Query tab; file — `path` (relative to the project, or absolute) and optional `line`; git — `view` \"review\" "
      + "(Review changes, the default) or \"log\"; settings — optional `section`. Answers the tab id, the project "
      + "shown and `previousProject`.",
    inputSchema: object({
      project: PROJECT,
      kind: { type: "string", enum: [...ASSISTANT_TAB_KINDS] },
      target: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionId: { type: "string" },
          providerId: { type: "string", enum: ["claude", "codex"] },
          connectionId: { type: ["integer", "string"] },
          table: { type: "string" },
          schema: { type: "string" },
          database: { type: "string" },
          path: { type: "string" },
          line: { type: "integer", minimum: 1 },
          view: { type: "string", enum: ["review", "log"] },
          section: { type: "string" },
        },
      },
    }, ["project", "kind"]),
    annotations: NAV,
  },
  {
    name: UI_FOCUS_TAB_TOOL,
    title: "Bring a tab forward",
    description: "Bring an open tab to the front on the chatting device, switching to the project it belongs to when "
      + "another is showing. Answers the project shown and `previousProject`.",
    inputSchema: object({ tabId: TAB_ID }, ["tabId"]),
    annotations: NAV,
  },
  {
    name: UI_SWITCH_PROJECT_TOOL,
    title: "Switch project",
    description: "Show another registered project on the chatting device. Answers `previousProject`, which this tool "
      + "takes to switch back.",
    inputSchema: object({ project: PROJECT }, ["project"]),
    annotations: NAV,
  },
  {
    name: UI_CLOSE_TAB_TOOL,
    title: "Close a tab",
    description: "Close an open tab on the chatting device. A tab whose close would lose work — unsaved editor text, "
      + "unsaved SQL or table edits, a terminal and whatever runs in it — is not closed: the answer says it needs the "
      + "user's approval. Answers what was closed, enough to open it again.",
    inputSchema: object({ tabId: TAB_ID }, ["tabId"]),
    annotations: { ...NAV, idempotentHint: false },
  },
] as const;

export const UI_READ_TAB_DEFINITION = {
  name: UI_READ_TAB_TOOL,
  title: "Read a tab",
  description: "Read what one open tab shows on the device the user is chatting from (ids from ui_get_state). "
    + `An editor: the file, or its unsaved text when it has changes not saved yet — up to ${READ_TAB_MAX_LINES} lines `
    + "a call; read on with `offset` (the line the answer's `nextOffset` gives). A terminal: its newest "
    + `${READ_TAB_TERMINAL_LINES} lines, colours removed; \`offset\` skips that many newest lines to read further back. `
    + `A chat: its newest ${READ_TAB_CHAT_MESSAGES} messages; \`offset\` reads the ones before that index. A database tab: `
    + `its SQL and up to ${READ_TAB_DB_ROWS} of the rows it shows. Other tabs: a description only. A file outside every `
    + "registered project is not read without the user's approval. Read only what the task needs.",
  inputSchema: {
    type: "object",
    properties: {
      tabId: { type: "string", description: "The tab's id, from ui_get_state." },
      offset: { type: "integer", minimum: 0, description: "Where to continue reading, from an earlier answer." },
    },
    required: ["tabId"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
} as const;
