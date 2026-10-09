import {
  UI_CLOSE_TAB_TOOL, UI_FOCUS_TAB_TOOL, UI_LIST_COMMANDS_TOOL, UI_OPEN_TAB_TOOL, UI_READ_TAB_TOOL, UI_RUN_COMMAND_TOOL,
  UI_SWITCH_PROJECT_TOOL,
} from "../../shared/assistant-tool-names.ts";
import { ASSISTANT_TAB_KINDS, MAX_ASSISTANT_COMMAND_ID_CHARS, MAX_ASSISTANT_COMMANDS_LISTED } from "../../shared/assistant-ui-protocol.ts";
import {
  READ_TAB_CHAT_MESSAGES, READ_TAB_DB_ROWS, READ_TAB_MAX_LINES, READ_TAB_TERMINAL_LINES,
} from "../../shared/assistant-tab-content.ts";

/**
 * How the Assistant's screen tools are described to the agent: the ones that move around the
 * screen, the one that reads a tab, and the two that list and run PPM's commands. Definitions
 * only, so the tool list can be built without loading what the tools reach (handlers:
 * `assistant-ui-nav-tools.ts`, `assistant-ui-read-tool.ts`, `assistant-ui-command-tools.ts`).
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
      + "unsaved SQL or table edits, a terminal and whatever runs in it — is closed only once the user approves the "
      + "card this shows them. Answers what was closed, enough to open it again.",
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
    + `its SQL and up to ${READ_TAB_DB_ROWS} of the rows it shows. Other tabs: a description only. A file or terminal outside every `
    + "registered project is read only after the user approves the card this shows them. Read only what the task needs.",
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

export const UI_COMMAND_TOOL_DEFINITIONS = [
  {
    name: UI_LIST_COMMANDS_TOOL,
    title: "List PPM commands",
    description: "List the commands of PPM's command palette as the device the user is chatting from offers them "
      + "right now (they depend on its project, screen size and extensions): id, label, keyboard shortcut and "
      + "`changesData` — whether running it asks the user first. `query` keeps those whose id, label or keywords "
      + `contain every word of it. At most ${MAX_ASSISTANT_COMMANDS_LISTED}; \`total\` says how many matched.`,
    inputSchema: object({ query: { type: "string", description: "Words to look for." } }, []),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: UI_RUN_COMMAND_TOOL,
    title: "Run a PPM command",
    description: "Run one command from ui_list_commands on the device the user is chatting from, exactly as picking it "
      + "in the command palette would, in the project that device shows. A command that changes data — every "
      + "extension command among them — runs only once the user approves the card this shows them. Runs once, on "
      + "that one device. Answers what ran and in which project.",
    inputSchema: object({
      id: { type: "string", minLength: 1, maxLength: MAX_ASSISTANT_COMMAND_ID_CHARS, description: "The command's id, from ui_list_commands." },
      args: { type: "object", description: "Arguments, for a command that takes them. No PPM command takes any yet: leave it out." },
    }, ["id"]),
    // An extension's command may reach outside (a git pull), so this is not a closed-world tool.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
] as const;
