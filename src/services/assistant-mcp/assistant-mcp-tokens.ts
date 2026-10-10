import { localServerBaseUrl } from "../server-listen-address.ts";
import { createSessionTokenStore } from "../mcp-session-tokens.ts";
import type { AssistantMcpAccess } from "./assistant-mcp-tools.ts";

/**
 * Capability tokens for the Assistant's MCP endpoint, one per Assistant session (see
 * `mcp-session-tokens.ts`). A token names the session and nothing else: which project a tool
 * works on is an argument of each call, checked against the registered projects then, and the
 * endpoint confirms on every call that the session is still an Assistant session.
 */

export const ASSISTANT_MCP_PATH = "/api/assistant-mcp";
export const MAX_ASSISTANT_MCP_TOKENS = 128;

export interface AssistantMcpTokenBinding {
  sessionId: string;
}

export function createAssistantMcpTokenStore(max = MAX_ASSISTANT_MCP_TOKENS) {
  return createSessionTokenStore<AssistantMcpTokenBinding>({ max, sameBinding: () => true });
}

export const assistantMcpTokens = createAssistantMcpTokenStore();

/**
 * How one Assistant session's agent reaches its tools, or null when it cannot: a process that
 * serves no HTTP (the CLI) has no endpoint to point at. The URL uses the port this server
 * actually listens on.
 */
export function assistantMcpAccessFor(sessionId: string): AssistantMcpAccess | null {
  const base = localServerBaseUrl();
  if (!base) return null;
  return { url: `${base}${ASSISTANT_MCP_PATH}`, token: assistantMcpTokens.mint({ sessionId }) };
}
