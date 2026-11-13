import { localServerBaseUrl } from "../server-listen-address.ts";
import { createSessionTokenStore } from "../mcp-session-tokens.ts";

/**
 * Capability tokens for the spec tools' endpoint, one per chat session (see
 * `mcp-session-tokens.ts`). A token names the session alone: which spec and which task it may
 * act on is looked up from the session's binding at every call (`spec-store.ts`), so a chat that
 * enters Spec mode mid-way needs no new token and a warm CLI's token stays valid.
 */

export const SPEC_MCP_PATH = "/api/specs-mcp";
export const MAX_SPEC_MCP_TOKENS = 256;
/** Environment variable the Codex app-server reads the bearer token from. */
export const CODEX_SPEC_MCP_TOKEN_ENV = "PPM_SPECS_MCP_TOKEN";
/**
 * The providers' own timeout for one call: `task_green` can run the whole suite (20 minutes at
 * most) after the task's own tests, and the agent must not give up on a run that then records.
 */
export const SPEC_TOOLS_TIMEOUT_MS = 30 * 60_000;

export interface SpecMcpBinding {
  sessionId: string;
}

export interface SpecMcpAccess {
  url: string;
  token: string;
}

export const specMcpTokens = createSessionTokenStore<SpecMcpBinding>({ max: MAX_SPEC_MCP_TOKENS, sameBinding: () => true });

/** How one session's agent reaches the spec tools, or null in a process that serves no HTTP. */
export function specMcpAccessFor(sessionId: string): SpecMcpAccess | null {
  const base = localServerBaseUrl();
  if (!base) return null;
  return { url: `${base}${SPEC_MCP_PATH}`, token: specMcpTokens.mint({ sessionId }) };
}
