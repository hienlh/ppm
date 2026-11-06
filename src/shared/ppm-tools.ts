/**
 * PPM's own AI tools, one switch each in Settings → Tools (`ai.ppm_tools`). Shared so the pane
 * shows the same answer the server acts on.
 */
import { DB_TOOLS } from "./db-ai-tools.ts";
import {
  OPEN_FILE_TOOL, OPEN_PREVIEW_TOOL, OPEN_URL_TOOL, READ_TERMINAL_TOOL, RUN_IN_TERMINAL_TOOL,
} from "./tab-open-protocol.ts";
import { SESSION_HISTORY_TOOLS } from "./session-history-tools.ts";
import { SESSION_COLLAB_TOOLS } from "./session-collab.ts";

export const TERMINAL_TOOLS = [READ_TERMINAL_TOOL, RUN_IN_TERMINAL_TOOL] as const;
/**
 * What `/api/tab-tools-mcp` serves: the tools that show or read something on the user's side, and
 * the session-history tools that read the project's other chats.
 */
export const TAB_TOOLS = [OPEN_FILE_TOOL, OPEN_PREVIEW_TOOL, OPEN_URL_TOOL, ...TERMINAL_TOOLS, ...SESSION_HISTORY_TOOLS] as const;
/**
 * What `/api/sessions-mcp` serves: opening another PPM session and messaging the project's
 * sessions. Every session they create is an ordinary one the user sees, can open and can stop.
 */
export const SESSION_TOOLS = SESSION_COLLAB_TOOLS;
export const PPM_TOOLS = [...TAB_TOOLS, ...DB_TOOLS, ...SESSION_TOOLS] as const;
/** The two the single switch before these (`tab_tools`) turned on and off. */
const LEGACY_TAB_TOOLS: readonly string[] = [OPEN_FILE_TOOL, OPEN_PREVIEW_TOOL];
export type PpmTool = (typeof PPM_TOOLS)[number];
export type PpmToolSwitches = Partial<Record<PpmTool, boolean>>;

export const isPpmTool = (name: unknown): name is PpmTool => (PPM_TOOLS as readonly unknown[]).includes(name);

/**
 * Whether `tool` is on. One the user never switched takes its default: `open_file` and
 * `open_preview` follow the single switch that came before these (`tab_tools`, off unless set),
 * and every other tool is on — the database tools reach only the connections marked *Available
 * to the AI chat*, nothing `run_in_terminal` types runs before the user presses Enter, and a
 * session tool asks before creating a session unless the user switched that off.
 */
export function ppmToolOn(ai: { tab_tools?: boolean; ppm_tools?: PpmToolSwitches }, tool: PpmTool): boolean {
  const set = ai.ppm_tools?.[tool];
  if (typeof set === "boolean") return set;
  return LEGACY_TAB_TOOLS.includes(tool) ? ai.tab_tools === true : true;
}

/** Whether a chat needs the MCP server that serves `tools`: at least one of them is on. */
export const anyPpmToolOn = (ai: Parameters<typeof ppmToolOn>[0], tools: readonly PpmTool[]): boolean =>
  tools.some((tool) => ppmToolOn(ai, tool));

/** What a call to a tool the user has since turned off answers: a chat keeps the tools it started with. */
export const ppmToolOffMessage = (tool: string): string =>
  `The user turned off ${tool} in PPM's settings (Settings → Tools), so it did nothing.`;
