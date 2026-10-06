import { createSessionTokenStore } from "../../mcp-session-tokens.ts";

/**
 * Capability tokens for the design MCP endpoint, one per design session (see
 * `mcp-session-tokens.ts`). A token names one session, one project and one design, and
 * nothing else can be reached with it.
 */

export interface DesignMcpBinding {
  sessionId: string;
  projectPath: string;
  slug: string;
}

/** Enough for every design session a server could plausibly keep alive at once. */
export const MAX_DESIGN_MCP_TOKENS = 256;

export function createDesignMcpTokenStore(max = MAX_DESIGN_MCP_TOKENS) {
  // A changed project or design replaces the session's token.
  return createSessionTokenStore<DesignMcpBinding>({
    max,
    sameBinding: (held, wanted) => held.projectPath === wanted.projectPath && held.slug === wanted.slug,
  });
}

export const designMcpTokens = createDesignMcpTokenStore();
