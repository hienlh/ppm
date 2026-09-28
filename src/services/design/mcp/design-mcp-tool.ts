/**
 * The one tool the design MCP endpoint serves, and the names each provider knows it by.
 *
 * Claude addresses MCP tools as `mcp__<server>__<tool>`, which is the name its permission
 * hooks see and the one pre-approved for design sessions. Codex takes the server name from
 * its config key, where a hyphen is not a safe character, hence the separate name.
 */

export const DESIGN_CHECK_TOOL = "design_check";
export const CLAUDE_DESIGN_MCP_SERVER = "ppm-design";
export const CLAUDE_DESIGN_CHECK_TOOL = `mcp__${CLAUDE_DESIGN_MCP_SERVER}__${DESIGN_CHECK_TOOL}`;
export const CODEX_DESIGN_MCP_SERVER = "ppm_design";
/** Environment variable the Codex app-server reads the bearer token from. */
export const CODEX_DESIGN_MCP_TOKEN_ENV = "PPM_DESIGN_MCP_TOKEN";
/** A check waits up to 20 s for a browser; the providers' own tool timeout must exceed that. */
export const DESIGN_CHECK_TOOL_TIMEOUT_MS = 45_000;

/** How a provider reaches the endpoint for one session; built by `chatService` per turn. */
export interface DesignMcpAccess {
  url: string;
  token: string;
}

export const DESIGN_CHECK_TOOL_DEFINITION = {
  name: DESIGN_CHECK_TOOL,
  title: "Check the design canvas",
  description:
    "Check the live design canvas open in the user's browser and report what is wrong with the rendered page: "
    + "grid items pushed into implicit tracks, content overflowing the page or cut off by a parent, elements "
    + "squeezed to nothing, blocks drawn over each other, and script or loading errors. Also returns the frame "
    + "size and, unless screenshot is false, a screenshot. Call it after changing the design and fix every "
    + "finding before saying you are done. Needs the design's tab to be open in PPM.",
  inputSchema: {
    type: "object",
    properties: {
      screenshot: { type: "boolean", description: "Include a screenshot of the canvas (default true)." },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};
