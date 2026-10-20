import { existsSync, readFileSync } from "node:fs";

/**
 * The MCP servers a mocked `query()` was started with. The provider hands them to the CLI in a
 * config file named by `extraArgs["mcp-config"]` (never as JSON on its command line), so they are
 * read back from there, plus any in-process ones left in `mcpServers`. Undefined when none.
 *
 * Read it while the file still exists: the provider deletes it once the CLI answers its first
 * request, which a mock with `initializationResult` does at once.
 */
export function passedMcpServers(options: { mcpServers?: Record<string, any>; extraArgs?: Record<string, string | null> }): Record<string, any> | undefined {
  const path = options.extraArgs?.["mcp-config"];
  const fromFile = path && existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as { mcpServers: Record<string, any> }).mcpServers
    : {};
  const all = { ...(options.mcpServers ?? {}), ...fromFile };
  return Object.keys(all).length > 0 ? all : undefined;
}
