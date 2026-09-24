import { describe, expect, it } from "bun:test";
import { designMcpServers } from "../../../src/providers/claude-agent-sdk-query-options.ts";
import { buildThreadParams, designMcpEnv } from "../../../src/providers/codex-app-server/codex-thread-params.ts";
import { mcpResultText } from "../../../src/providers/codex-app-server/codex-event-mapper.ts";
import { CLAUDE_DESIGN_CHECK_TOOL } from "../../../src/services/design/mcp/design-mcp-tool.ts";

const access = { url: "http://127.0.0.1:8123/api/design-mcp", token: "tok-secret" };
const permission = { sandbox: "workspace-write", approvalPolicy: "never" } as const;

describe("design MCP server in provider options", () => {
  it("gives Claude an http server with the token in the header, only for design sessions", () => {
    expect(designMcpServers(undefined)).toEqual({});
    const servers = designMcpServers(access);
    expect(servers).toEqual({
      "ppm-design": { type: "http", url: access.url, headers: { Authorization: "Bearer tok-secret" }, timeout: 45_000 },
    });
    expect(CLAUDE_DESIGN_CHECK_TOOL).toBe("mcp__ppm-design__design_check");
  });

  it("gives Codex one dotted mcp_servers override with the token only in the environment", () => {
    const plain = buildThreadParams({ cwd: "/p", permission, configOverrides: { config: { model_context_window: 1000 } } });
    expect(plain.config).toEqual({ model_context_window: 1000 });
    expect(buildThreadParams({ cwd: "/p", permission })).not.toHaveProperty("config");

    const design = buildThreadParams({ cwd: "/p", permission, configOverrides: { config: { model_context_window: 1000 } }, designMcp: access });
    expect(design.config).toEqual({
      model_context_window: 1000,
      "mcp_servers.ppm_design": {
        url: access.url, bearer_token_env_var: "PPM_DESIGN_MCP_TOKEN", enabled_tools: ["design_check"],
        default_tools_approval_mode: "approve", startup_timeout_sec: 10, tool_timeout_sec: 45,
      },
    });
    expect(JSON.stringify(design)).not.toContain("tok-secret");
    expect(designMcpEnv(access)).toEqual({ PPM_DESIGN_MCP_TOKEN: "tok-secret" });
    expect(designMcpEnv(undefined)).toEqual({});
  });

  it("shows a Codex MCP result's text and labels its images instead of dumping base64", () => {
    expect(mcpResultText({ content: [{ type: "text", text: "found 1" }, { type: "image", data: "A".repeat(5000), mimeType: "image/jpeg" }] }))
      .toBe("found 1\n[image image/jpeg]");
    expect(mcpResultText(undefined)).toBeUndefined();
    expect(mcpResultText("plain")).toBe("plain");
  });
});
