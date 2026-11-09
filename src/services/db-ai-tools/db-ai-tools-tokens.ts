import { localServerBaseUrl } from "../server-listen-address.ts";
import { createSessionTokenStore } from "../mcp-session-tokens.ts";
import type { DbToolsMcpAccess } from "./db-ai-tools-tool.ts";

/**
 * Capability tokens for the database tools' MCP endpoint, one per chat session (see
 * `mcp-session-tokens.ts`). A token reaches the connections the AI chat may use, and its writes
 * only through an approval shown in that one session's chat. Like the tab tools' token it names
 * the session alone, so a warm CLI's token is the one its session's first turn mints.
 */

export const DB_TOOLS_MCP_PATH = "/api/db-tools-mcp";
export const MAX_DB_TOOLS_MCP_TOKENS = 256;

export interface DbToolsTokenBinding {
  sessionId: string;
}

export function createDbToolsMcpTokenStore(max = MAX_DB_TOOLS_MCP_TOKENS) {
  return createSessionTokenStore<DbToolsTokenBinding>({ max, sameBinding: () => true });
}

export const dbToolsMcpTokens = createDbToolsMcpTokenStore();

/**
 * How one session's agent reaches the database tools, or null when it cannot: a process that
 * serves no HTTP (the CLI) has no endpoint to point at, and no chat to ask for approval in.
 */
export function dbToolsMcpAccessFor(sessionId: string): DbToolsMcpAccess | null {
  const base = localServerBaseUrl();
  if (!base) return null;
  return { url: `${base}${DB_TOOLS_MCP_PATH}`, token: dbToolsMcpTokens.mint({ sessionId }) };
}
