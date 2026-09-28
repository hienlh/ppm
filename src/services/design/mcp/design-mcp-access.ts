import { localServerBaseUrl } from "../../server-listen-address.ts";
import { designMcpTokens } from "./design-mcp-tokens.ts";
import type { DesignMcpAccess } from "./design-mcp-tool.ts";

export const DESIGN_MCP_PATH = "/api/design-mcp";

/**
 * How one design session's agent reaches `design_check`, or null when it cannot: a process
 * that serves no HTTP (the CLI) has no endpoint to point at, and a session without a
 * project has no design to check. The URL uses the port this server actually listens on.
 */
export function designMcpAccessFor(sessionId: string, projectPath: string | null | undefined, slug: string): DesignMcpAccess | null {
  const base = localServerBaseUrl();
  if (!base || !projectPath) return null;
  return { url: `${base}${DESIGN_MCP_PATH}`, token: designMcpTokens.mint({ sessionId, projectPath, slug }) };
}
