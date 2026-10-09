import { localServerBaseUrl } from "../server-listen-address.ts";
import { createSessionTokenStore } from "../mcp-session-tokens.ts";
import type { TabToolsMcpAccess } from "./tab-tools-mcp-tool.ts";

/**
 * Capability tokens for the tab-tools MCP endpoint, one per chat session (see
 * `mcp-session-tokens.ts`). A token acts for that one session only: it opens tabs on the
 * session's devices, reads the terminals its chat may read, and types — never runs — a command
 * into a terminal it opened.
 *
 * It names the session and nothing else — the project is looked up when a tool is called —
 * so the token a warm CLI is started with, before its session has a project, is the one the
 * session's first turn mints too, and the warm process can be taken over.
 */

export const TAB_TOOLS_MCP_PATH = "/api/tab-tools-mcp";
export const MAX_TAB_TOOLS_MCP_TOKENS = 256;

export interface TabToolsTokenBinding {
  sessionId: string;
}

export function createTabToolsMcpTokenStore(max = MAX_TAB_TOOLS_MCP_TOKENS) {
  return createSessionTokenStore<TabToolsTokenBinding>({ max, sameBinding: () => true });
}

export const tabToolsMcpTokens = createTabToolsMcpTokenStore();

/**
 * How one session's agent reaches the tab tools, or null when it cannot: a process that
 * serves no HTTP (the CLI) has no endpoint to point at, and no browser to open a tab in.
 * The URL uses the port this server actually listens on.
 */
export function tabToolsMcpAccessFor(sessionId: string): TabToolsMcpAccess | null {
  const base = localServerBaseUrl();
  if (!base) return null;
  return { url: `${base}${TAB_TOOLS_MCP_PATH}`, token: tabToolsMcpTokens.mint({ sessionId }) };
}
