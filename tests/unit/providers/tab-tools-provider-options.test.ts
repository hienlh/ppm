import { describe, expect, it } from "bun:test";
import { CLAUDE_TAB_TOOLS, tabToolsMcpServers, withSessionTokenMasked } from "../../../src/providers/claude-agent-sdk-query-options.ts";
import { buildThreadParams, tabToolsMcpEnv } from "../../../src/providers/codex-app-server/codex-thread-params.ts";
import { spawnFingerprint } from "../../../src/providers/claude-warm-spare.ts";

const access = { url: "http://127.0.0.1:8080/api/tab-tools-mcp", token: "tok-secret" };
const permission = { sandbox: "workspace-write", approvalPolicy: "never" } as any;

describe("tab tools provider options", () => {
  it("gives Claude one http server with the token in its header, and pre-approves every tool", () => {
    expect(tabToolsMcpServers(undefined)).toEqual({});
    expect(tabToolsMcpServers(access)).toEqual({
      "ppm-tabs": { type: "http", url: access.url, headers: { Authorization: "Bearer tok-secret" }, timeout: 60_000 },
    });
    expect(CLAUDE_TAB_TOOLS).toEqual([
      "mcp__ppm-tabs__open_file", "mcp__ppm-tabs__open_preview", "mcp__ppm-tabs__open_url",
      "mcp__ppm-tabs__read_terminal", "mcp__ppm-tabs__run_in_terminal",
    ]);
  });

  it("lets a warm spare started before its session's token match the session's own turns", () => {
    const options = (token: string) => ({ cwd: "/p", mcpServers: { other: { type: "http", url: "u", headers: { Authorization: "Bearer keep" } }, ...tabToolsMcpServers({ ...access, token }) } });
    expect(spawnFingerprint(withSessionTokenMasked(options("")))).toBe(spawnFingerprint(withSessionTokenMasked(options("tok-a"))));
    // Only the tab tools' token is blanked: another server's header still counts, and so does
    // whether the tab tools are there at all.
    const changed = { ...options("tok-a"), mcpServers: { ...options("tok-a").mcpServers, other: { type: "http", url: "u", headers: { Authorization: "Bearer new" } } } };
    expect(spawnFingerprint(withSessionTokenMasked(changed))).not.toBe(spawnFingerprint(withSessionTokenMasked(options("tok-a"))));
    expect(spawnFingerprint(withSessionTokenMasked({ cwd: "/p", mcpServers: { other: options("").mcpServers.other } })))
      .not.toBe(spawnFingerprint(withSessionTokenMasked(options(""))));
    const plain = { cwd: "/p" };
    expect(withSessionTokenMasked(plain)).toBe(plain);
  });

  it("gives Codex a dotted mcp_servers override beside the design one, with the token only in the environment", () => {
    const params = buildThreadParams({ cwd: "/p", permission, tabToolsMcp: access, designMcp: { url: "http://d", token: "d" } });
    expect(params.config!["mcp_servers.ppm_tabs"]).toEqual({
      url: access.url, bearer_token_env_var: "PPM_TAB_TOOLS_MCP_TOKEN", enabled_tools: ["open_file", "open_preview", "open_url", "read_terminal", "run_in_terminal"],
      default_tools_approval_mode: "approve", startup_timeout_sec: 10, tool_timeout_sec: 60,
    });
    expect(Object.keys(params.config!)).toEqual(["mcp_servers.ppm_design", "mcp_servers.ppm_tabs"]);
    expect(JSON.stringify(params)).not.toContain("tok-secret");
    expect(tabToolsMcpEnv(access)).toEqual({ PPM_TAB_TOOLS_MCP_TOKEN: "tok-secret" });
    expect(tabToolsMcpEnv(undefined)).toEqual({});
    expect(buildThreadParams({ cwd: "/p", permission })).not.toHaveProperty("config");
  });
});
