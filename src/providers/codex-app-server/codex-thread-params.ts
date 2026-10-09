import type { CodexPermission } from "./codex-permission-map.ts";
import type { ThreadStartParams } from "./codex-protocol.ts";
import {
  CODEX_DESIGN_MCP_SERVER, CODEX_DESIGN_MCP_TOKEN_ENV, DESIGN_CHECK_TOOL, DESIGN_CHECK_TOOL_TIMEOUT_MS,
  type DesignMcpAccess,
} from "../../services/design/mcp/design-mcp-tool.ts";
import {
  CODEX_TAB_TOOLS_MCP_SERVER, CODEX_TAB_TOOLS_MCP_TOKEN_ENV, OPEN_FILE_TOOL, OPEN_PREVIEW_TOOL, TAB_TOOLS_TIMEOUT_MS,
  type TabToolsMcpAccess,
} from "../../services/tab-tools-mcp/tab-tools-mcp-tool.ts";

/** Config overrides, keyed like `-c key=value` on codex's command line (dotted paths). */
export type CodexConfigOverrides = Record<string, unknown>;

/** The overrides both thread/start and thread/resume carry (resume adds threadId + path). */
export type CodexThreadParams = ThreadStartParams & { config?: CodexConfigOverrides };

export interface ThreadParamsInput {
  cwd: string;
  permission: CodexPermission;
  model?: string;
  /** Provider-wide config overrides, already shaped as `{ config }` or `{}`. */
  configOverrides?: { config?: CodexConfigOverrides };
  developerInstructions?: string;
  /** A design session's `design_check` endpoint; added as one more MCP server. */
  designMcp?: DesignMcpAccess;
  /** The tab tools (`open_file`, `open_preview`) while the user has them on; likewise. */
  tabToolsMcp?: TabToolsMcpAccess;
}

/**
 * The design MCP server as a codex config override. The dotted key adds this one server and
 * leaves the user's own `mcp_servers` alone. The token is not in the config: codex reads it
 * from the app-server's environment (`bearer_token_env_var`), so it is never written into a
 * thread's saved settings, and codex's default shell policy drops `*TOKEN*` variables from
 * the commands the agent runs. The tool only reads the canvas, so it is approved up front —
 * an approval prompt here would reach PPM as an elicitation it declines, cancelling the call.
 */
export function designMcpConfig(access: DesignMcpAccess | undefined): CodexConfigOverrides {
  if (!access) return {};
  return {
    [`mcp_servers.${CODEX_DESIGN_MCP_SERVER}`]: {
      url: access.url,
      bearer_token_env_var: CODEX_DESIGN_MCP_TOKEN_ENV,
      enabled_tools: [DESIGN_CHECK_TOOL],
      default_tools_approval_mode: "approve",
      startup_timeout_sec: 10,
      tool_timeout_sec: Math.ceil(DESIGN_CHECK_TOOL_TIMEOUT_MS / 1000),
    },
  };
}

/** The environment the app-server needs for {@link designMcpConfig}; `{}` for other sessions. */
export function designMcpEnv(access: DesignMcpAccess | undefined): Record<string, string> {
  return access ? { [CODEX_DESIGN_MCP_TOKEN_ENV]: access.token } : {};
}

/**
 * The tab-tools MCP server, shaped and approved exactly like {@link designMcpConfig}: the
 * tools only open a tab for the user to look at.
 */
export function tabToolsMcpConfig(access: TabToolsMcpAccess | undefined): CodexConfigOverrides {
  if (!access) return {};
  return {
    [`mcp_servers.${CODEX_TAB_TOOLS_MCP_SERVER}`]: {
      url: access.url,
      bearer_token_env_var: CODEX_TAB_TOOLS_MCP_TOKEN_ENV,
      enabled_tools: [OPEN_FILE_TOOL, OPEN_PREVIEW_TOOL],
      default_tools_approval_mode: "approve",
      startup_timeout_sec: 10,
      tool_timeout_sec: Math.ceil(TAB_TOOLS_TIMEOUT_MS / 1000),
    },
  };
}

/** The environment the app-server needs for {@link tabToolsMcpConfig}; `{}` without the tools. */
export function tabToolsMcpEnv(access: TabToolsMcpAccess | undefined): Record<string, string> {
  return access ? { [CODEX_TAB_TOOLS_MCP_TOKEN_ENV]: access.token } : {};
}

/**
 * One builder for the params of every thread/start and thread/resume — the first connect
 * and the account-switch respawn used to assemble them separately, which is how a field
 * added to one silently goes missing from the other. `developerInstructions` is left out
 * entirely when empty, so an ordinary session sends exactly what it always has.
 */
export function buildThreadParams(input: ThreadParamsInput): CodexThreadParams {
  const instructions = input.developerInstructions?.trim();
  const config = {
    ...(input.configOverrides?.config ?? {}),
    ...designMcpConfig(input.designMcp),
    ...tabToolsMcpConfig(input.tabToolsMcp),
  };
  return {
    ...(Object.keys(config).length ? { config } : {}),
    cwd: input.cwd,
    sandbox: input.permission.sandbox,
    approvalPolicy: input.permission.approvalPolicy,
    ...(input.model ? { model: input.model } : {}),
    ...(instructions ? { developerInstructions: instructions } : {}),
  };
}

/** A codex build that predates `developerInstructions` rejects it as an unknown field. */
export function isUnknownDeveloperInstructionsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /developerInstructions|developer_instructions/.test(message)
    && /unknown|unexpected|unrecognized|not allowed|invalid/i.test(message);
}

/** Why a session whose instructions are not optional cannot run on this codex. */
export const REQUIRED_INSTRUCTIONS_UNSUPPORTED =
  "This Codex version cannot take the instructions a PPM Assistant session runs with. Update Codex (npm i -g @openai/codex) to use the Assistant on Codex.";

/** A thread request refused because the session's required instructions could not be sent. */
export class RequiredInstructionsError extends Error {
  constructor(message = REQUIRED_INSTRUCTIONS_UNSUPPORTED) {
    super(message);
    this.name = "RequiredInstructionsError";
  }
}

/**
 * Send a thread request, and if an older codex refuses the instructions field, send it
 * once more without it — a design session that loses its instructions still works as a
 * chat, while a refused thread/start is no session at all. Logged, never silent.
 *
 * `required` is for a session that must not run without them (a PPM Assistant session, whose
 * instructions carry its rules): there the refusal, or instructions missing from the params
 * altogether, is an error that says so instead of a quiet retry.
 */
export async function requestWithInstructionsFallback<T>(
  params: CodexThreadParams,
  send: (params: CodexThreadParams) => Promise<T>,
  log: (message: string) => void = console.warn,
  required = false,
): Promise<T> {
  if (required && !params.developerInstructions) {
    throw new RequiredInstructionsError("This session cannot start without its instructions, and none were given.");
  }
  try {
    return await send(params);
  } catch (err) {
    if (!params.developerInstructions || !isUnknownDeveloperInstructionsError(err)) throw err;
    if (required) throw new RequiredInstructionsError();
    log("[codex] app-server rejected developerInstructions; retrying without design instructions");
    const { developerInstructions: _dropped, ...rest } = params;
    return send(rest);
  }
}
