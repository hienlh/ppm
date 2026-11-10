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
import { SPEC_TOOLS } from "./spec-tools.ts";
import { answerFromSwitches, featureIntroOfTool } from "./feature-intros.ts";

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
/** What `/api/specs-mcp` serves: Spec mode's steps (submit a document, start and finish tasks, test runs). */
export const SPEC_MODE_TOOLS = SPEC_TOOLS;
export const PPM_TOOLS = [...TAB_TOOLS, ...DB_TOOLS, ...SESSION_TOOLS, ...SPEC_MODE_TOOLS] as const;
/** The two the single switch before these (`tab_tools`) turned on and off. */
const LEGACY_TAB_TOOLS: readonly string[] = [OPEN_FILE_TOOL, OPEN_PREVIEW_TOOL];
export type PpmTool = (typeof PPM_TOOLS)[number];
export type PpmToolSwitches = Partial<Record<PpmTool, boolean>>;

export const isPpmTool = (name: unknown): name is PpmTool => (PPM_TOOLS as readonly unknown[]).includes(name);

/**
 * Whether `tool` is on. One the user never switched takes its default: `open_file` and
 * `open_preview` follow the single switch that came before these (`tab_tools`, off unless set);
 * a tool of a feature the tour introduces (`src/shared/feature-intros.ts`) is off until the user
 * decides, and follows the feature's other switches once any is set; every other tool is on —
 * the database tools reach only the connections marked *Available to the AI chat*, and nothing
 * `run_in_terminal` types runs before the user presses Enter.
 *
 * Every server path that decides whether a tool is offered or callable comes through here with
 * the stored `ai` settings, so the introduced features' default cannot differ between them.
 */
export function ppmToolOn(ai: { tab_tools?: boolean; ppm_tools?: PpmToolSwitches }, tool: PpmTool): boolean {
  const set = ai.ppm_tools?.[tool];
  if (typeof set === "boolean") return set;
  const intro = featureIntroOfTool(tool);
  if (intro) return answerFromSwitches(ai.ppm_tools, intro) === "on";
  return LEGACY_TAB_TOOLS.includes(tool) ? ai.tab_tools === true : true;
}

/**
 * `current` with `patch` applied, as Settings → Tools saves one switch. A patched tool that
 * belongs to an introduced feature first writes the feature's other tools at the state they show
 * now, so flipping one switch never flips its siblings by making the feature count as decided.
 */
export function patchPpmToolSwitches(current: PpmToolSwitches | undefined, patch: PpmToolSwitches): PpmToolSwitches {
  const next: PpmToolSwitches = { ...current };
  for (const tool of Object.keys(patch)) {
    const intro = featureIntroOfTool(tool);
    if (!intro) continue;
    for (const sibling of intro.tools) next[sibling] = ppmToolOn({ ppm_tools: current }, sibling);
  }
  return { ...next, ...patch };
}

/** Whether a chat needs the MCP server that serves `tools`: at least one of them is on. */
export const anyPpmToolOn = (ai: Parameters<typeof ppmToolOn>[0], tools: readonly PpmTool[]): boolean =>
  tools.some((tool) => ppmToolOn(ai, tool));

/** What a call to a tool the user has since turned off answers: a chat keeps the tools it started with. */
export const ppmToolOffMessage = (tool: string): string =>
  `The user turned off ${tool} in PPM's settings (Settings → Tools), so it did nothing.`;
