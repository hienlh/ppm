import { CODEX_ASSISTANT_MCP_SERVER } from "../../shared/assistant-tool-names.ts";
import { CONTROL_REQUEST_TIMEOUT_MS } from "./codex-jsonrpc-client.ts";

/**
 * A PPM Assistant session approves its `ppm_assistant` tools up front, so that name must reach
 * PPM's endpoint and nothing else. PPM's server is a per-thread config override, and codex
 * layers config files under it table by table: a `[mcp_servers.ppm_assistant]` in the user's own
 * config could leave keys of its own (a `command`, say) beside PPM's `url` and be what answers.
 * Before such a session starts, the config codex would use without PPM's overrides is read back
 * (`config/read`); if it already defines a server by that name, the session refuses to start
 * rather than run with an approval meant for PPM.
 *
 * A codex that cannot answer `config/read` is let through, logged: the request is the only way
 * to ask, and refusing would make the Assistant unusable on it for a conflict it almost
 * certainly does not have.
 */

export class AssistantMcpNameConflictError extends Error {
  constructor() {
    super(`Your Codex configuration already defines an MCP server named "${CODEX_ASSISTANT_MCP_SERVER}", which the PPM Assistant `
      + "needs for its own tools. Rename or remove that server in your Codex config.toml to use the Assistant on Codex.");
    this.name = "AssistantMcpNameConflictError";
  }
}

interface ConfigReader {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

export async function assertNoUserAssistantMcpServer(
  client: ConfigReader,
  cwd: string,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  let config: unknown;
  try {
    const result = await client.request<{ config?: unknown }>("config/read", { cwd, includeLayers: false }, CONTROL_REQUEST_TIMEOUT_MS);
    config = result?.config;
  } catch (e) {
    warn(`[codex] config/read failed; could not check for a user MCP server named ${CODEX_ASSISTANT_MCP_SERVER}: ${(e as Error).message}`);
    return;
  }
  const servers = config && typeof config === "object" ? (config as { mcp_servers?: unknown }).mcp_servers : undefined;
  if (servers && typeof servers === "object" && Object.hasOwn(servers, CODEX_ASSISTANT_MCP_SERVER)) {
    throw new AssistantMcpNameConflictError();
  }
}
