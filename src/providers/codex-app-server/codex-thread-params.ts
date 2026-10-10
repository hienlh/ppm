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
import {
  ASSISTANT_MCP_TIMEOUT_MS, CODEX_ASSISTANT_MCP_TOKEN_ENV, type AssistantMcpAccess,
} from "../../services/assistant-mcp/assistant-mcp-tools.ts";
import { ASSISTANT_TOOLS, CODEX_ASSISTANT_MCP_SERVER } from "../../shared/assistant-tool-names.ts";
import type { AssistantMcpServer } from "../../shared/assistant-settings.ts";

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
  /** Set for a PPM Assistant session; see {@link CodexAssistantSession}. */
  assistant?: CodexAssistantSession;
}

/** What a PPM Assistant session's app-server is configured with. */
export interface CodexAssistantSession {
  /** Its own tools' endpoint, when this server has one. */
  mcp?: AssistantMcpAccess;
  /** The servers the user connected for the Assistant in Settings → PPM Assistant. */
  servers?: AssistantMcpServer[];
  /**
   * The user's own codex MCP servers, read from the config this app-server loaded
   * (`planAssistantCodexMcp`): each is switched off for the session. Resolved per app-server,
   * since every account has a CODEX_HOME, and so a config.toml, of its own.
   */
  disableUserServers?: string[];
  /** Every skill this app-server can see (`planAssistantCodexSkills`): each is switched off by name. */
  disableSkills?: string[];
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
 * The servers of Settings → PPM Assistant as codex config overrides. Every tool asks first
 * (`default_tools_approval_mode: "prompt"`): codex brings the request to PPM as an elicitation,
 * which an Assistant session shows as an approval card. Env and header values travel in the
 * override like the rest of the server, over the app-server's stdin and never on a command line.
 */
export function assistantUserMcpConfig(servers: readonly AssistantMcpServer[] | undefined): CodexConfigOverrides {
  const out: CodexConfigOverrides = {};
  for (const server of servers ?? []) {
    if (!server.enabled) continue;
    out[`mcp_servers.${server.name}`] = server.transport === "stdio"
      ? {
        command: server.command,
        args: [...server.args],
        ...(Object.keys(server.env).length ? { env: { ...server.env } } : {}),
        enabled: true,
        default_tools_approval_mode: "prompt",
      }
      : {
        url: server.url,
        ...(Object.keys(server.headers).length ? { http_headers: { ...server.headers } } : {}),
        enabled: true,
        default_tools_approval_mode: "prompt",
      };
  }
  return out;
}

/**
 * A PPM Assistant session's config overrides: codex's built-in web search off — it reaches out
 * with no approval card, and the Assistant reads content it did not write — and the
 * Assistant's tools. The tools only read, or ask inside the endpoint before changing anything,
 * so they are approved up front like the design and tab tools; the long timeout leaves room for
 * a slow query or an approval the user takes a while to answer. `{}` for any other session.
 *
 * The session is kept apart from the user's own codex setup: each of the user's MCP servers is
 * switched off (`enabled = false`), and so are apps (ChatGPT connectors) and plugins, which bring
 * tools of their own, and hooks, which run the user's commands around the agent's. `notify` is
 * emptied for the same reason: it names a program of the user's that codex runs after every turn,
 * handed the turn's messages, and codex installs it whether or not the hooks feature is on; an
 * empty list installs nothing. The servers of Settings → PPM Assistant take their place. MCP tool
 * approvals are asked as elicitations (`tool_call_mcp_elicitation`), answered by an approval card
 * that offers no "always allow". Every key is one codex 0.161 recognises: under `--strict-config`
 * it refuses an unknown key, and refuses `notify` unless it is a list.
 *
 * Skills are kept out too: their catalogue leaves the prompt (`skills.include_instructions`),
 * codex's bundled ones are not loaded, and each skill the app-server reports is disabled by name,
 * which is what stops a `$skill-name` in a message from pulling a SKILL.md in
 * (`planAssistantCodexSkills`). The user's global instructions file (`$CODEX_HOME/AGENTS.md`)
 * has no setting at all; it is left behind by running on a home of the Assistant's own
 * (`codex-assistant-home.ts`).
 */
export function assistantSessionConfig(assistant: ThreadParamsInput["assistant"]): CodexConfigOverrides {
  if (!assistant) return {};
  const access = assistant.mcp;
  const disabled = Object.fromEntries((assistant.disableUserServers ?? []).map((name) => [`mcp_servers.${name}.enabled`, false]));
  const skills = assistant.disableSkills ?? [];
  return {
    web_search: "disabled",
    "features.apps": false,
    "features.plugins": false,
    "features.hooks": false,
    notify: [],
    "features.tool_call_mcp_elicitation": true,
    "skills.include_instructions": false,
    "skills.bundled.enabled": false,
    ...(skills.length ? { "skills.config": skills.map((name) => ({ name, enabled: false })) } : {}),
    ...disabled,
    ...assistantUserMcpConfig(assistant.servers),
    ...(access ? {
      [`mcp_servers.${CODEX_ASSISTANT_MCP_SERVER}`]: {
        url: access.url,
        bearer_token_env_var: CODEX_ASSISTANT_MCP_TOKEN_ENV,
        enabled_tools: [...ASSISTANT_TOOLS],
        default_tools_approval_mode: "approve",
        startup_timeout_sec: 10,
        tool_timeout_sec: Math.ceil(ASSISTANT_MCP_TIMEOUT_MS / 1000),
      },
    } : {}),
  };
}

/** The environment the app-server needs for {@link assistantSessionConfig}'s tools; `{}` without them. */
export function assistantMcpEnv(access: AssistantMcpAccess | undefined): Record<string, string> {
  return access ? { [CODEX_ASSISTANT_MCP_TOKEN_ENV]: access.token } : {};
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
    ...assistantSessionConfig(input.assistant),
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
