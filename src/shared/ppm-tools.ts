/**
 * PPM's own AI tools, one switch each in Settings → Tools (`ai.ppm_tools`). Shared so the pane
 * shows the same answer the server acts on.
 */
import { DB_TOOLS } from "./db-ai-tools.ts";
import { OPEN_FILE_TOOL, OPEN_PREVIEW_TOOL } from "./tab-open-protocol.ts";

export const TAB_TOOLS = [OPEN_FILE_TOOL, OPEN_PREVIEW_TOOL] as const;
export const PPM_TOOLS = [...TAB_TOOLS, ...DB_TOOLS] as const;
export type PpmTool = (typeof PPM_TOOLS)[number];
export type PpmToolSwitches = Partial<Record<PpmTool, boolean>>;

export const isPpmTool = (name: unknown): name is PpmTool => (PPM_TOOLS as readonly unknown[]).includes(name);

/**
 * Whether `tool` is on. One the user never switched takes its default: the tab tools follow the
 * single switch that came before these (`tab_tools`, off unless set), and the database tools are
 * on — they reach only the connections marked *Available to the AI chat*.
 */
export function ppmToolOn(ai: { tab_tools?: boolean; ppm_tools?: PpmToolSwitches }, tool: PpmTool): boolean {
  const set = ai.ppm_tools?.[tool];
  if (typeof set === "boolean") return set;
  return (TAB_TOOLS as readonly string[]).includes(tool) ? ai.tab_tools === true : true;
}

/** Whether a chat needs the MCP server that serves `tools`: at least one of them is on. */
export const anyPpmToolOn = (ai: Parameters<typeof ppmToolOn>[0], tools: readonly PpmTool[]): boolean =>
  tools.some((tool) => ppmToolOn(ai, tool));

/** What a call to a tool the user has since turned off answers: a chat keeps the tools it started with. */
export const ppmToolOffMessage = (tool: string): string =>
  `The user turned off ${tool} in PPM's settings (Settings → Tools), so it did nothing.`;
