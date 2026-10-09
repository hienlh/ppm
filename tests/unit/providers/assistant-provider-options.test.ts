/**
 * How each provider is handed the PPM Assistant's MCP servers: its own and the ones the user
 * connected for it in Settings → PPM Assistant, and none of the user's others. Claude takes SDK
 * server configs (its Assistant policy is covered in claude-assistant-policy-hook.test.ts); Codex
 * takes config overrides — its own server approved up front with the token in the app-server's
 * environment, the user's Assistant servers asking on every tool, each of the user's own codex
 * servers switched off — runs with web search, apps, plugins and hooks off, and refuses to start on a
 * name clash or a config it cannot read.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { assistantMcpServers } from "../../../src/providers/claude-agent-sdk-query-options.ts";
import {
  assistantMcpEnv, assistantSessionConfig, assistantUserMcpConfig, buildThreadParams,
} from "../../../src/providers/codex-app-server/codex-thread-params.ts";
import {
  AssistantMcpConfigUnreadableError, AssistantMcpNameConflictError, planAssistantCodexMcp,
} from "../../../src/providers/codex-app-server/codex-assistant-mcp-guard.ts";
import { CodexAppServerProvider } from "../../../src/providers/codex-app-server/codex-provider.ts";
import { CodexJsonRpcClient } from "../../../src/providers/codex-app-server/codex-jsonrpc-client.ts";
import { ASSISTANT_PERMISSION } from "../../../src/providers/codex-app-server/codex-permission-map.ts";
import * as accounts from "../../../src/services/codex-account.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { ASSISTANT_TOOLS } from "../../../src/shared/assistant-tool-names.ts";
import { CODEX_ASSISTANT_MCP_TOKEN_ENV } from "../../../src/services/assistant-mcp/assistant-mcp-tools.ts";
import type { AssistantMcpServer } from "../../../src/shared/assistant-settings.ts";

const ACCESS = { url: "http://127.0.0.1:8125/api/assistant-mcp", token: "tok-123" };
const SERVERS: AssistantMcpServer[] = [
  { id: "1", name: "github", enabled: true, transport: "stdio", command: "npx", args: ["gh-mcp"], env: { GH_TOKEN: "secret-gh" } },
  { id: "2", name: "docs", enabled: true, transport: "http", url: "https://docs.example/mcp", headers: { "X-Key": "secret-docs" } },
  { id: "3", name: "off", enabled: false, transport: "stdio", command: "x", args: [], env: {} },
];
const ISOLATION = { web_search: "disabled", "features.apps": false, "features.plugins": false, "features.hooks": false, "features.tool_call_mcp_elicitation": true };

describe("Claude", () => {
  it("is an http server named ppm-assistant with a 12-minute timeout, the token in the header", () => {
    expect(assistantMcpServers(ACCESS)).toEqual({
      "ppm-assistant": { type: "http", url: ACCESS.url, headers: { Authorization: "Bearer tok-123" }, timeout: 720_000 },
    });
    expect(assistantMcpServers(null)).toEqual({});
    expect(assistantMcpServers(undefined)).toEqual({});
  });

  it("adds the enabled servers of the Assistant's settings, its own written last", () => {
    const servers = assistantMcpServers(ACCESS, SERVERS);
    expect(Object.keys(servers)).toEqual(["github", "docs", "ppm-assistant"]);
    expect(servers.github).toEqual({ type: "stdio", command: "npx", args: ["gh-mcp"], env: { GH_TOKEN: "secret-gh" } });
    expect(servers.docs).toEqual({ type: "http", url: "https://docs.example/mcp", headers: { "X-Key": "secret-docs" } });
    expect(Object.keys(assistantMcpServers(null, SERVERS))).toEqual(["github", "docs"]);
  });
});

describe("Codex config", () => {
  it("turns web search, apps, plugins and hooks off and approves the Assistant's tools up front, with a 720 s tool timeout", () => {
    expect(assistantSessionConfig({ mcp: ACCESS })).toEqual({
      ...ISOLATION,
      "mcp_servers.ppm_assistant": {
        url: ACCESS.url,
        bearer_token_env_var: CODEX_ASSISTANT_MCP_TOKEN_ENV,
        enabled_tools: [...ASSISTANT_TOOLS],
        default_tools_approval_mode: "approve",
        startup_timeout_sec: 10,
        tool_timeout_sec: 720,
      },
    });
    // No endpoint: still kept apart from the user's setup.
    expect(assistantSessionConfig({})).toEqual(ISOLATION);
    expect(assistantSessionConfig(undefined)).toEqual({});
  });

  it("adds the Assistant's enabled servers, every tool asking, and switches the user's own off", () => {
    expect(assistantUserMcpConfig(SERVERS)).toEqual({
      "mcp_servers.github": { command: "npx", args: ["gh-mcp"], env: { GH_TOKEN: "secret-gh" }, enabled: true, default_tools_approval_mode: "prompt" },
      "mcp_servers.docs": { url: "https://docs.example/mcp", http_headers: { "X-Key": "secret-docs" }, enabled: true, default_tools_approval_mode: "prompt" },
    });
    const config = assistantSessionConfig({ mcp: ACCESS, servers: SERVERS, disableUserServers: ["mine", "work"] });
    expect(config).toMatchObject({ "mcp_servers.mine.enabled": false, "mcp_servers.work.enabled": false, "mcp_servers.github": { default_tools_approval_mode: "prompt" } });
    expect(Object.keys(config)).not.toContain("mcp_servers.off");
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

describe("Codex user servers", () => {
  const reader = (answer: unknown | Error) => ({
    request: async () => { if (answer instanceof Error) throw answer; return answer as never; },
  });
  const plan = (answer: unknown, opts = { ownServer: true, privateNames: ["github"] }) => planAssistantCodexMcp(reader(answer), "/w", opts);

  it("lists every server of the user's config to switch off", async () => {
    expect(await plan({ config: { mcp_servers: { mine: { command: "x" }, work: { url: "http://x" } } } })).toEqual(["mine", "work"]);
    expect(await plan({ config: {} })).toEqual([]);
  });

  it("refuses when the user's config defines the Assistant's own server, or one of its settings' servers", async () => {
    await expect(plan({ config: { mcp_servers: { ppm_assistant: { command: "evil" } } } })).rejects.toBeInstanceOf(AssistantMcpNameConflictError);
    await expect(plan({ config: { mcp_servers: { github: { command: "gh" } } } })).rejects.toThrow('named "github"');
    // Without its own endpoint, a user ppm_assistant is just switched off like the rest.
    expect(await plan({ config: { mcp_servers: { ppm_assistant: {} } } }, { ownServer: false, privateNames: [] })).toEqual(["ppm_assistant"]);
  });

  it("refuses a codex that cannot answer config/read rather than run with the user's servers", async () => {
    await expect(plan(new Error("Method not found"))).rejects.toBeInstanceOf(AssistantMcpConfigUnreadableError);
    await expect(plan({ config: { mcp_servers: { "bad.name": {} } } })).rejects.toBeInstanceOf(AssistantMcpConfigUnreadableError);
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

  it("switches the user's own servers off and starts the Assistant's", async () => {
    userServers = { mine: { command: "x" }, work: { url: "http://x" } };
    await (provider as any).connect((await provider.createSession({})).id, { ...OPTS, assistantMcpServers: SERVERS.slice(0, 2) });
    const start = requests.find((r) => r.method === "thread/start")!.value;
    expect(start.config).toMatchObject({
      "mcp_servers.mine.enabled": false, "mcp_servers.work.enabled": false,
      "mcp_servers.github": { command: "npx", default_tools_approval_mode: "prompt" },
      "mcp_servers.docs": { url: "https://docs.example/mcp", default_tools_approval_mode: "prompt" },
    });
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
