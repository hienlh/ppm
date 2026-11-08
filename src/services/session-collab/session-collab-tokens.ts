import { localServerBaseUrl } from "../server-listen-address.ts";
import { createSessionTokenStore } from "../mcp-session-tokens.ts";
import type { SessionCollabMcpAccess } from "./session-collab-tool.ts";

/**
 * Capability tokens for the session tools' MCP endpoint, one per chat session (see
 * `mcp-session-tokens.ts`). A token acts for that one session only: it creates sessions in that
 * session's project and messages that project's sessions, every call checked against the
 * session's canonical id. Like the tab tools' token it names the session alone, so a warm CLI's
 * token is the one its session's first turn mints.
 */

export const SESSION_COLLAB_MCP_PATH = "/api/sessions-mcp";
export const MAX_SESSION_COLLAB_MCP_TOKENS = 256;

export interface SessionCollabTokenBinding {
  sessionId: string;
}

export function createSessionCollabMcpTokenStore(max = MAX_SESSION_COLLAB_MCP_TOKENS) {
  return createSessionTokenStore<SessionCollabTokenBinding>({ max, sameBinding: () => true });
}

export const sessionCollabMcpTokens = createSessionCollabMcpTokenStore();

/**
 * How one session's agent reaches the session tools, or null when it cannot: a process that serves
 * no HTTP (the CLI) has no endpoint to point at, and no chats to deliver into.
 */
export function sessionCollabMcpAccessFor(sessionId: string): SessionCollabMcpAccess | null {
  const base = localServerBaseUrl();
  if (!base) return null;
  return { url: `${base}${SESSION_COLLAB_MCP_PATH}`, token: sessionCollabMcpTokens.mint({ sessionId }) };
}
