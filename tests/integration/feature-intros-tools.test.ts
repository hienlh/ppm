/**
 * The six session tools stay off for every chat until the tour's question is answered: the real
 * app, the real chat preparation, the real MCP endpoints and the options both providers are given.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../test-setup.ts";
import { randomUUID } from "node:crypto";
import { app } from "../../src/server/index.ts";
import { configService } from "../../src/services/config.service.ts";
import { chatService } from "../../src/services/chat.service.ts";
import { providerRegistry } from "../../src/providers/registry.ts";
import { setServerListenAddress } from "../../src/services/server-listen-address.ts";
import { SESSION_COLLAB_MCP_PATH } from "../../src/services/session-collab/session-collab-tokens.ts";
import { TAB_TOOLS_MCP_PATH } from "../../src/services/tab-tools-mcp/tab-tools-mcp-tokens.ts";
import { sessionCollabMcpServers, tabToolsMcpServers } from "../../src/providers/claude-agent-sdk-query-options.ts";
import { buildThreadParams } from "../../src/providers/codex-app-server/codex-thread-params.ts";
import { FEATURE_INTROS } from "../../src/shared/feature-intros.ts";
import { SESSION_HISTORY_TOOLS } from "../../src/shared/session-history-tools.ts";
import { SESSION_COLLAB_TOOLS } from "../../src/shared/session-collab.ts";
import type { AIProvider, SendMessageOpts } from "../../src/types/chat.ts";

const INTRO = FEATURE_INTROS[0]!;
const permission = { sandbox: "workspace-write", approvalPolicy: "never" } as never;

const stub: AIProvider = {
  id: "stub-intros", name: "stub-intros", supportsDesignInstructions: true,
  async createSession() { return { id: "x", providerId: "stub-intros", title: "", createdAt: "" }; },
  async resumeSession() { return { id: "x", providerId: "stub-intros", title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage(_s: string, _m: string, _o?: SendMessageOpts) {},
};

/** The names an MCP endpoint lists for a chat's token. */
async function listed(path: string, token: string): Promise<string[]> {
  const res = await app.request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
  return body.result.tools.map((tool) => tool.name);
}

async function prepare() {
  const opts = await chatService.prepareSendOptions("stub-intros", randomUUID(), "hi");
  const codex = buildThreadParams({ cwd: "/p", permission, tabToolsMcp: opts.tabToolsMcp, sessionCollabMcp: opts.sessionCollabMcp });
  const claude = { ...tabToolsMcpServers(opts.tabToolsMcp ?? null), ...sessionCollabMcpServers(opts.sessionCollabMcp ?? null) };
  return { opts, codex, claude };
}

beforeAll(() => {
  providerRegistry.register(stub);
  setServerListenAddress(8125, "0.0.0.0");
  configService.set("feature_intros", {});
  const { ppm_tools: _drop, ...rest } = configService.get("ai");
  configService.set("ai", rest);
});
afterAll(() => {
  setServerListenAddress(0, "");
  configService.set("feature_intros", {});
  const { ppm_tools: _drop, ...rest } = configService.get("ai");
  configService.set("ai", rest);
});

describe("introduced session tools", () => {
  it("are offered to no chat before the question is answered, on either provider", async () => {
    const { opts, codex, claude } = await prepare();
    expect(opts).not.toHaveProperty("sessionCollabMcp");
    expect(Object.keys(claude)).toEqual(["ppm-tabs"]);
    expect(Object.keys(codex.config!).filter((k) => k.startsWith("mcp_servers."))).toEqual(["mcp_servers.ppm_tabs"]);
    const tabs = await listed(TAB_TOOLS_MCP_PATH, opts.tabToolsMcp!.token);
    expect(tabs).toContain("open_url");
    for (const tool of SESSION_HISTORY_TOOLS) expect(tabs).not.toContain(tool);
  });

  it("reach every chat once Turn on is answered", async () => {
    const res = await app.request(`/api/feature-intros/${INTRO.id}/answer`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: "on" }),
    });
    expect(res.status).toBe(200);
    const { opts, codex, claude } = await prepare();
    expect(Object.keys(claude).sort()).toEqual(["ppm-sessions", "ppm-tabs"]);
    expect(codex.config!["mcp_servers.ppm_sessions"]).toBeDefined();
    expect(await listed(SESSION_COLLAB_MCP_PATH, opts.sessionCollabMcp!.token)).toEqual([...SESSION_COLLAB_TOOLS]);
    const tabs = await listed(TAB_TOOLS_MCP_PATH, opts.tabToolsMcp!.token);
    for (const tool of SESSION_HISTORY_TOOLS) expect(tabs).toContain(tool);
  });
});
