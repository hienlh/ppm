/**
 * How each provider is handed the PPM Assistant's own tools. Claude takes an `http` MCP server
 * (covered with the rest of its Assistant policy in claude-assistant-policy-hook.test.ts); Codex
 * takes a config override approved up front, with the token in the app-server's environment,
 * runs with its built-in web search off, and refuses to start when the user's own codex config
 * already has a server under the Assistant's name.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { assistantMcpServers } from "../../../src/providers/claude-agent-sdk-query-options.ts";
import {
  assistantMcpEnv, assistantSessionConfig, buildThreadParams,
} from "../../../src/providers/codex-app-server/codex-thread-params.ts";
import {
  AssistantMcpNameConflictError, assertNoUserAssistantMcpServer,
} from "../../../src/providers/codex-app-server/codex-assistant-mcp-guard.ts";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";
import { CodexJsonRpcClient } from "../../../src/providers/codex-app-server/codex-jsonrpc-client.ts";
import { ASSISTANT_PERMISSION } from "../../../src/providers/codex-app-server/codex-permission-map.ts";
import * as accounts from "../../../src/services/codex-account.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { ASSISTANT_TOOLS } from "../../../src/shared/assistant-tool-names.ts";
import { CODEX_ASSISTANT_MCP_TOKEN_ENV } from "../../../src/services/assistant-mcp/assistant-mcp-tools.ts";

const ACCESS = { url: "http://127.0.0.1:8125/api/assistant-mcp", token: "tok-123" };

describe("Claude", () => {
  it("is an http server named ppm-assistant with a 12-minute timeout, the token in the header", () => {
    expect(assistantMcpServers(ACCESS)).toEqual({
      "ppm-assistant": { type: "http", url: ACCESS.url, headers: { Authorization: "Bearer tok-123" }, timeout: 720_000 },
    });
    expect(assistantMcpServers(null)).toEqual({});
    expect(assistantMcpServers(undefined)).toEqual({});
  });
});

describe("Codex config", () => {
  it("turns web search off and approves the Assistant's six tools up front, with a 720 s tool timeout", () => {
    expect(assistantSessionConfig({ mcp: ACCESS })).toEqual({
      web_search: "disabled",
      "mcp_servers.ppm_assistant": {
        url: ACCESS.url,
        bearer_token_env_var: CODEX_ASSISTANT_MCP_TOKEN_ENV,
        enabled_tools: [...ASSISTANT_TOOLS],
        default_tools_approval_mode: "approve",
        startup_timeout_sec: 10,
        tool_timeout_sec: 720,
      },
    });
    // No endpoint: still no web search.
    expect(assistantSessionConfig({})).toEqual({ web_search: "disabled" });
    expect(assistantSessionConfig(undefined)).toEqual({});
  });

  it("keeps the token out of the config and in the app-server's environment", () => {
    expect(JSON.stringify(assistantSessionConfig({ mcp: ACCESS }))).not.toContain(ACCESS.token);
    expect(assistantMcpEnv(ACCESS)).toEqual({ [CODEX_ASSISTANT_MCP_TOKEN_ENV]: ACCESS.token });
    expect(assistantMcpEnv(undefined)).toEqual({});
  });

  it("sends the overrides on every thread request of an Assistant session, and none on an ordinary one", () => {
    const base = { cwd: "/w", permission: ASSISTANT_PERMISSION };
    const params = buildThreadParams({ ...base, assistant: { mcp: ACCESS }, configOverrides: { config: { model_context_window: 1 } } });
    expect(params.config).toMatchObject({ model_context_window: 1, web_search: "disabled", "mcp_servers.ppm_assistant": { url: ACCESS.url } });
    expect(buildThreadParams(base)).not.toHaveProperty("config");
  });
});

describe("Codex user server under the Assistant's name", () => {
  const reader = (answer: unknown | Error) => ({
    request: async () => { if (answer instanceof Error) throw answer; return answer as never; },
  });

  it("refuses when the user's config defines one, and passes when it does not", async () => {
    await expect(assertNoUserAssistantMcpServer(reader({ config: { mcp_servers: { ppm_assistant: { command: "evil" } } } }), "/w"))
      .rejects.toBeInstanceOf(AssistantMcpNameConflictError);
    await assertNoUserAssistantMcpServer(reader({ config: { mcp_servers: { other: { url: "http://x" } } } }), "/w");
    await assertNoUserAssistantMcpServer(reader({ config: {} }), "/w");
  });

  it("lets a codex that cannot answer config/read through, saying so", async () => {
    const warnings: string[] = [];
    await assertNoUserAssistantMcpServer(reader(new Error("Method not found")), "/w", (m) => warnings.push(m));
    expect(warnings[0]).toContain("config/read failed");
  });
});

describe("Codex Assistant session start", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  let provider: CodexAppServerProvider;
  let requests: Array<{ method: string; value: any }>;
  let env: Record<string, string> | undefined;
  let userServers: Record<string, unknown>;
  let previousAi: ReturnType<typeof configService.get<"ai">>;

  beforeEach(() => {
    provider = new CodexAppServerProvider();
    requests = [];
    env = undefined;
    userServers = {};
    previousAi = configService.get("ai");
    configService.set("ai", { ...previousAi, providers: { ...previousAi.providers, codex: { type: "cli", cli_command: "codex" } } });
    spies.push(spyOn(accounts, "resolveCodexAccountForSession").mockResolvedValue(null));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "start").mockImplementation((opts: any) => { env = opts.env; }));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "notify").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "close").mockImplementation(() => {}));
    spies.push(spyOn(CodexJsonRpcClient.prototype, "request").mockImplementation(async (method: string, value: any) => {
      requests.push({ method, value });
      if (method === "config/read") return { config: { mcp_servers: userServers } };
      if (method === "thread/start") return { thread: { id: `thread-${crypto.randomUUID()}` } };
      return {};
    }));
  });
  afterEach(() => {
    provider.cleanupAll();
    configService.set("ai", previousAi);
    spies.splice(0).forEach((s) => s.mockRestore());
  });

  const OPTS = { assistantSession: true, assistantInstructions: "# PPM Assistant", assistantMcp: ACCESS };

  it("starts with the tools, the token in the environment and web search off", async () => {
    await (provider as any).connect((await provider.createSession({})).id, OPTS);
    expect(env).toMatchObject({ [CODEX_ASSISTANT_MCP_TOKEN_ENV]: ACCESS.token });
    const start = requests.find((r) => r.method === "thread/start")!.value;
    expect(start.config).toMatchObject({ web_search: "disabled", "mcp_servers.ppm_assistant": { url: ACCESS.url, default_tools_approval_mode: "approve" } });
    expect(requests.map((r) => r.method)).toEqual(["initialize", "config/read", "thread/start"]);
  });

  it("refuses to start when the user's codex config already has a ppm_assistant server", async () => {
    userServers = { ppm_assistant: { command: "evil" } };
    await expect((provider as any).connect((await provider.createSession({})).id, OPTS)).rejects.toBeInstanceOf(AssistantMcpNameConflictError);
    expect(requests.some((r) => r.method === "thread/start")).toBe(false);
  });

  it("does not ask config/read for an ordinary session", async () => {
    await (provider as any).connect((await provider.createSession({})).id, { permissionMode: "default" });
    expect(requests.map((r) => r.method)).toEqual(["initialize", "thread/start"]);
    expect(env?.[CODEX_ASSISTANT_MCP_TOKEN_ENV]).toBeUndefined();
  });
});
