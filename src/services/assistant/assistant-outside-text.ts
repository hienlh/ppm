/**
 * Which of a PPM Assistant turn's tool calls can put text the user did not write in front of the
 * Assistant: a file's content, a commit message, a schedule's prompt, a web page, another chat's
 * words, a tunnel's name. Any of these can carry instructions, so a turn that ran one is marked
 * untrusted and every message it sends a manager chat says so.
 *
 * An allowlist, not a denylist: a tool is assumed to bring outside text unless it is named here as
 * one that cannot. A tool added later is untrusted until someone decides otherwise. Pure.
 */
import {
  CLAUDE_ASSISTANT_MCP_PREFIX, CODEX_ASSISTANT_MCP_SERVER, NOTEBOOK_ADD_TOOL, NOTEBOOK_DELETE_TOOL, NOTEBOOK_EDIT_TOOL,
  PPM_CLI_REFERENCE_TOOL, PROJECT_ADD_TOOL, PROJECTS_LIST_TOOL, TERMINAL_TYPE_TOOL,
} from "../../shared/assistant-tool-names.ts";
import { CLAUDE_SESSION_COLLAB_MCP_SERVER, CODEX_SESSION_COLLAB_MCP_SERVER } from "../../shared/session-collab.ts";

/**
 * The Assistant's own tools that answer only with PPM's own data or the user's: the project list
 * (names the user registered), adding a project (it answers with the folder and name the user just
 * approved), PPM's fixed CLI reference, the notebook (whose lines are already in every turn's
 * context, marked by who wrote them), and typing into a terminal (it answers with PPM's own words,
 * the project and folder, never what the shell printed).
 */
const OWN_TOOLS_WITHOUT_OUTSIDE_TEXT: ReadonlySet<string> = new Set([
  PROJECTS_LIST_TOOL, PROJECT_ADD_TOOL, PPM_CLI_REFERENCE_TOOL, NOTEBOOK_ADD_TOOL, NOTEBOOK_EDIT_TOOL, NOTEBOOK_DELETE_TOOL,
  TERMINAL_TYPE_TOOL,
]);

/**
 * Provider tools that read nothing from outside the conversation: the to-do list, loading a tool
 * schema of the Assistant's own servers, and a question the user answers.
 */
const PROVIDER_TOOLS_WITHOUT_OUTSIDE_TEXT: ReadonlySet<string> = new Set(["TodoWrite", "ToolSearch", "AskUserQuestion"]);

/** Whether one of the Assistant's own MCP tools (bare name) can bring outside text. */
export function ownToolBringsOutsideText(tool: string): boolean {
  return !OWN_TOOLS_WITHOUT_OUTSIDE_TEXT.has(tool);
}

/**
 * Whether a tool call the provider reports (`tool_use`, by the provider's name for it) can bring
 * outside text. The Assistant's own tools and PPM's session tools are judged where they run, by
 * their endpoints, which know what each call returned: a send to a chat is not a read of it.
 */
export function toolUseBringsOutsideText(toolName: string): boolean {
  if (PROVIDER_TOOLS_WITHOUT_OUTSIDE_TEXT.has(toolName)) return false;
  return !JUDGED_BY_ENDPOINT.some((prefix) => toolName.startsWith(prefix));
}

/** Name prefixes of PPM's own MCP servers, as Claude (`mcp__<server>__`) and Codex (`<server>:`) spell them. */
const JUDGED_BY_ENDPOINT: readonly string[] = [
  CLAUDE_ASSISTANT_MCP_PREFIX, `mcp__${CLAUDE_SESSION_COLLAB_MCP_SERVER}__`,
  `${CODEX_ASSISTANT_MCP_SERVER}:`, `${CODEX_SESSION_COLLAB_MCP_SERVER}:`,
];
