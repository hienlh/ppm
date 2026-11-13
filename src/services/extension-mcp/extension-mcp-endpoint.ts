import { createMcpHttpHandler, textResult, type Json } from "../mcp-http-endpoint.ts";
import { boundToolsetsFor, type BoundToolsets } from "../extension-session-binding.service.ts";
import { EXTENSION_MCP_SERVER } from "../../shared/extension-session-binding.ts";
import { splitExposedToolName, toolsetKey } from "../../shared/extension-mcp.ts";
import { extensionMcpRegistry, type ExtensionMcpRegistry } from "./extension-mcp-registry.ts";
import { extensionMcpTokens, type ExtensionMcpTokenBinding } from "./extension-mcp-tokens.ts";

/**
 * `/api/ext-mcp` — the tools extensions registered (`ppm.mcp.registerToolset`), served as one
 * MCP server, `ppm-ext`, to the agent of a chat an extension bound with toolsets. The MCP
 * plumbing — token, Origin refusal, size cap — is `mcp-http-endpoint.ts`.
 *
 * Each request reads the session's binding again, so the agent reaches only the toolsets the
 * session is bound to at that moment and only those of the extension that owns the binding;
 * an unbind or a removed extension turns the next call into an error result. A tool the chat
 * listed while its extension was down answers "starting" until the extension registers again.
 */

export interface ExtensionMcpEndpointDeps {
  resolveToken: (token: string | null) => ExtensionMcpTokenBinding | null;
  registry: Pick<ExtensionMcpRegistry, "toolsFor" | "call">;
  boundToolsets: (sessionId: string, extensionId: string) => BoundToolsets;
  /** Which door the session's current turn came through; `unknown` when none is running. */
  turnOrigin: (sessionId: string) => Promise<string>;
}

export function createExtensionMcpHandler(deps: ExtensionMcpEndpointDeps) {
  const keysFor = ({ sessionId, extensionId }: ExtensionMcpTokenBinding): string[] => {
    const bound = deps.boundToolsets(sessionId, extensionId);
    return bound.ok ? bound.toolsets.map((id) => toolsetKey(extensionId, id)) : [];
  };

  return createMcpHttpHandler<ExtensionMcpTokenBinding>({
    serverName: EXTENSION_MCP_SERVER,
    tokenRequired: "A chat session token is required",
    resolveToken: deps.resolveToken,
    tools: (binding) => deps.registry.toolsFor(keysFor(binding)) as unknown as Json[],
    unlisted: ({ sessionId, extensionId }, name) => {
      const bound = deps.boundToolsets(sessionId, extensionId);
      if (!bound.ok) return bound.reason;
      const parts = splitExposedToolName(name);
      if (parts && !bound.toolsets.includes(parts.toolsetId)) return `This chat is no longer bound to the toolset "${parts.toolsetId}".`;
      return null;
    },
    callTool: async ({ sessionId, extensionId }, name, args, signal) => {
      const parts = splitExposedToolName(name);
      if (!parts) return textResult(`Unknown tool: ${name.slice(0, 60)}`, true);
      const ctx = { sessionId, turnOrigin: await deps.turnOrigin(sessionId) };
      const result = await deps.registry.call(toolsetKey(extensionId, parts.toolsetId), parts.name, args, ctx, signal);
      return textResult(result.text, result.isError === true);
    },
  });
}

export const extensionMcpHandler = createExtensionMcpHandler({
  resolveToken: (token) => extensionMcpTokens.resolve(token),
  registry: extensionMcpRegistry,
  boundToolsets: boundToolsetsFor,
  turnOrigin: async (sessionId) => {
    const { getSessionTurnOrigin } = await import("../../server/ws/chat.ts");
    return getSessionTurnOrigin(sessionId) ?? "unknown";
  },
});
