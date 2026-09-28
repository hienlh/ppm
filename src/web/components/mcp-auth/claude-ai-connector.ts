/**
 * claude.ai connectors (Slack, Gmail, Drive… added on claude.ai) reach Claude through the
 * account, not through local config, and the CLI names them `claude.ai <display name>`.
 * Its `mcp_authenticate` answers "Server not found" for them in SDK mode, so they are
 * connected where they were added — on claude.ai — rather than through a local flow.
 */
export const CLAUDE_AI_CONNECTORS_URL = "https://claude.ai/settings/connectors";

export function isClaudeAiConnector(name: string, scope?: string): boolean {
  return scope === "claudeai" || name.startsWith("claude.ai ");
}
