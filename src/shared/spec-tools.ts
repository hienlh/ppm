/**
 * The tools Spec mode gives a chat's AI (`/api/specs-mcp`), and the names each provider knows
 * them by. Shared so the browser can draw their cards and Settings → Tools can switch them.
 */
export const SPEC_STATUS_TOOL = "spec_status";
export const SPEC_CREATE_TOOL = "spec_create";
export const SPEC_SUBMIT_TOOL = "spec_submit";
export const TASK_START_TOOL = "task_start";
export const TASK_DONE_TOOL = "task_done";
export const TASK_RED_TOOL = "task_red";
export const TASK_GREEN_TOOL = "task_green";
export const SUITE_CHECK_TOOL = "suite_check";
export const SPEC_OPEN_DESIGN_TOOL = "spec_open_design";

export const SPEC_TOOLS = [
  SPEC_STATUS_TOOL, SPEC_CREATE_TOOL, SPEC_SUBMIT_TOOL, SPEC_OPEN_DESIGN_TOOL,
  TASK_START_TOOL, TASK_DONE_TOOL, TASK_RED_TOOL, TASK_GREEN_TOOL, SUITE_CHECK_TOOL,
] as const;
export type SpecTool = (typeof SPEC_TOOLS)[number];
export const isSpecTool = (name: unknown): name is SpecTool => (SPEC_TOOLS as readonly unknown[]).includes(name);

export const CLAUDE_SPEC_MCP_SERVER = "ppm-specs";
/** Codex takes the server name from a config key, where a hyphen is not safe. */
export const CODEX_SPEC_MCP_SERVER = "ppm_specs";

/** Environment a provider without MCP (Cursor) gets, for `ppm spec call`. */
export const SPEC_TOKEN_ENV = "PPM_SPEC_TOKEN";
export const SPEC_URL_ENV = "PPM_SPEC_URL";

/** The bare tool name of a call as any provider names it (`mcp__ppm-specs__task_red`, `ppm_specs:task_red`, …). */
export function specToolOf(name: string): SpecTool | null {
  const bare = name
    .replace(new RegExp(`^mcp__${CLAUDE_SPEC_MCP_SERVER}__`), "")
    .replace(new RegExp(`^mcp_${CLAUDE_SPEC_MCP_SERVER}_`), "")
    .replace(new RegExp(`^${CODEX_SPEC_MCP_SERVER}[:.]`), "");
  return bare !== name && isSpecTool(bare) ? bare : null;
}
