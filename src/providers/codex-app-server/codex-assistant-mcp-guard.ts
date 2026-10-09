import { CODEX_ASSISTANT_MCP_SERVER } from "../../shared/assistant-tool-names.ts";
import { CONTROL_REQUEST_TIMEOUT_MS } from "./codex-jsonrpc-client.ts";

/**
 * A PPM Assistant session on codex runs with the MCP servers PPM gives it and none of the user's
 * own. Codex has no switch for "ignore my config.toml", and its `CODEX_HOME` is also where the
 * login lives, so the session is given the user's servers to switch off one by one: before the
 * thread starts, the config this app-server would use without PPM's overrides is read back
 * (`config/read`), and every server in it is disabled for the session.
 *
 * Codex layers config table by table, so a server PPM defines under a name the user's config also
 * uses would be merged with it, key by key — the user's `command` beside PPM's `url` (measured on
 * codex 0.161: the thread then fails to load its config), or worse, the user's keys quietly
 * answering under a name PPM approved. A clash refuses the session instead, naming the server.
 *
 * Fail-closed: when the config cannot be read, the user's servers cannot be switched off, and the
 * session refuses to start rather than run with them.
 */

export class AssistantMcpNameConflictError extends Error {
  constructor(name: string = CODEX_ASSISTANT_MCP_SERVER) {
    super(name === CODEX_ASSISTANT_MCP_SERVER
      ? `Your Codex configuration already defines an MCP server named "${name}", which the PPM Assistant `
        + "needs for its own tools. Rename or remove that server in your Codex config.toml to use the Assistant on Codex."
      : `Your Codex configuration already defines an MCP server named "${name}", and so do the Assistant's settings. `
        + "Rename it in Settings → PPM Assistant (or in your Codex config.toml) to use the Assistant on Codex.");
    this.name = "AssistantMcpNameConflictError";
  }
}

export class AssistantMcpConfigUnreadableError extends Error {
  constructor(detail: string) {
    super(`Codex could not report its MCP configuration (${detail}), so the PPM Assistant cannot keep your own `
      + "MCP servers out of its session. Update Codex (npm i -g @openai/codex) and try again.");
    this.name = "AssistantMcpConfigUnreadableError";
  }
}

interface ConfigReader {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

/** A name codex accepts for a server, and so one a dotted config key can address. */
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * The user's codex MCP servers to switch off for an Assistant session. `ownServer` says whether
 * PPM will define its own `ppm_assistant` server; `privateNames` are the servers of Settings →
 * PPM Assistant. Throws {@link AssistantMcpNameConflictError} on a clash and
 * {@link AssistantMcpConfigUnreadableError} when the config cannot be read.
 */
export async function planAssistantCodexMcp(
  client: ConfigReader,
  cwd: string,
  opts: { ownServer: boolean; privateNames: readonly string[] },
): Promise<string[]> {
  let config: unknown;
  try {
    const result = await client.request<{ config?: unknown }>("config/read", { cwd, includeLayers: false }, CONTROL_REQUEST_TIMEOUT_MS);
    config = result?.config;
  } catch (e) {
    throw new AssistantMcpConfigUnreadableError((e as Error).message);
  }
  const raw = config && typeof config === "object" ? (config as { mcp_servers?: unknown }).mcp_servers : undefined;
  const names = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : [];
  if (opts.ownServer && names.includes(CODEX_ASSISTANT_MCP_SERVER)) throw new AssistantMcpNameConflictError();
  const clash = names.find((n) => opts.privateNames.includes(n));
  if (clash) throw new AssistantMcpNameConflictError(clash);
  const unsafe = names.find((n) => !SAFE_NAME.test(n));
  if (unsafe) throw new AssistantMcpConfigUnreadableError(`a server name PPM cannot address: ${JSON.stringify(unsafe)}`);
  return names;
}
