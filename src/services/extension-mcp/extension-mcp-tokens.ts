import { localServerBaseUrl } from "../server-listen-address.ts";
import { createSessionTokenStore } from "../mcp-session-tokens.ts";

/**
 * Capability tokens for `/api/ext-mcp`, one per chat session an extension bound with toolsets
 * (see `mcp-session-tokens.ts`). A token names the session and the extension that owns its
 * binding; which toolsets it reaches is read from the binding on every request, so it is never
 * wider than what the session is bound to at that moment.
 *
 * A Claude query keeps the MCP config it started with for every later turn, so the token holds
 * for as long as the session and the extension stay the same — a changed toolset list does not
 * replace it.
 */

export const EXTENSION_MCP_PATH = "/api/ext-mcp";
export const MAX_EXTENSION_MCP_TOKENS = 256;

export interface ExtensionMcpTokenBinding {
  sessionId: string;
  extensionId: string;
}

/** The endpoint as one session's agent reaches it. */
export interface ExtensionMcpAccess {
  url: string;
  token: string;
}

export function createExtensionMcpTokenStore(max = MAX_EXTENSION_MCP_TOKENS) {
  return createSessionTokenStore<ExtensionMcpTokenBinding>({
    max,
    sameBinding: (held, wanted) => held.sessionId === wanted.sessionId && held.extensionId === wanted.extensionId,
  });
}

export const extensionMcpTokens = createExtensionMcpTokenStore();

/** How the session's agent reaches its extension's tools, or null in a process that serves no HTTP. */
export function extensionMcpAccessFor(sessionId: string, extensionId: string): ExtensionMcpAccess | null {
  const base = localServerBaseUrl();
  if (!base) return null;
  return { url: `${base}${EXTENSION_MCP_PATH}`, token: extensionMcpTokens.mint({ sessionId, extensionId }) };
}

/** Revokes the tokens of these sessions — those of an extension being removed. */
export function revokeExtensionMcpTokens(sessionIds: readonly string[]): void {
  for (const sessionId of sessionIds) extensionMcpTokens.revoke(sessionId);
}
