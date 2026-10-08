import { describe, expect, it } from "bun:test";
import {
  CLAUDE_DB_TOOLS, dbToolsMcpServers, tabToolsMcpServers, withSessionTokenMasked,
} from "../../../src/providers/claude-agent-sdk-query-options.ts";
import { buildThreadParams, dbToolsMcpEnv } from "../../../src/providers/codex-app-server/codex-thread-params.ts";
import { spawnFingerprint } from "../../../src/providers/claude-warm-spare.ts";
import { DB_TOOLS_TIMEOUT_MS } from "../../../src/services/db-ai-tools/db-ai-tools-tool.ts";
import { DB_APPROVAL_WAIT_MS } from "../../../src/services/db-ai-tools/db-approval-broker.ts";

const access = { url: "http://127.0.0.1:8080/api/db-tools-mcp", token: "db-secret" };
const permission = { sandbox: "workspace-write", approvalPolicy: "never" } as any;

describe("database tools provider options", () => {
  it("gives Claude one http server whose timeout outlasts an approval, with the three tools pre-approved", () => {
    expect(dbToolsMcpServers(undefined)).toEqual({});
    expect(dbToolsMcpServers(access)).toEqual({
      "ppm-db": { type: "http", url: access.url, headers: { Authorization: "Bearer db-secret" }, timeout: DB_TOOLS_TIMEOUT_MS },
    });
    expect(DB_TOOLS_TIMEOUT_MS).toBeGreaterThan(DB_APPROVAL_WAIT_MS);
    expect(CLAUDE_DB_TOOLS).toEqual(["mcp__ppm-db__db_query", "mcp__ppm-db__open_query", "mcp__ppm-db__db_execute"]);
  });

  it("lets a warm spare match its session's turns whatever the database tools' token is", () => {
    const options = (tabs: string, db: string) => ({
      cwd: "/p",
      mcpServers: { ...tabToolsMcpServers({ url: "http://t", token: tabs }), ...dbToolsMcpServers({ ...access, token: db }) },
    });
    expect(spawnFingerprint(withSessionTokenMasked(options("", "")))).toBe(spawnFingerprint(withSessionTokenMasked(options("t1", "d1"))));
    // Whether the database tools are there at all still counts.
    const withoutDb = { cwd: "/p", mcpServers: tabToolsMcpServers({ url: "http://t", token: "t1" }) };
    expect(spawnFingerprint(withSessionTokenMasked(withoutDb))).not.toBe(spawnFingerprint(withSessionTokenMasked(options("t1", "d1"))));
    // The token itself is left alone in the options the session runs with.
    const real = options("t1", "d1");
    withSessionTokenMasked(real);
    expect(real.mcpServers["ppm-db"]!.headers).toEqual({ Authorization: "Bearer d1" });
  });

  it("gives Codex an approved mcp_servers override for the three tools, with the token only in the environment", () => {
    const params = buildThreadParams({ cwd: "/p", permission, dbToolsMcp: access, tabToolsMcp: { url: "http://t", token: "t" } });
    expect(params.config!["mcp_servers.ppm_db"]).toEqual({
      url: access.url, bearer_token_env_var: "PPM_DB_TOOLS_MCP_TOKEN", enabled_tools: ["db_query", "open_query", "db_execute"],
      default_tools_approval_mode: "approve", startup_timeout_sec: 10, tool_timeout_sec: Math.ceil(DB_TOOLS_TIMEOUT_MS / 1000),
    });
    expect(Object.keys(params.config!)).toEqual(["mcp_servers.ppm_tabs", "mcp_servers.ppm_db"]);
    expect(JSON.stringify(params)).not.toContain("db-secret");
    expect(dbToolsMcpEnv(access)).toEqual({ PPM_DB_TOOLS_MCP_TOKEN: "db-secret" });
    expect(dbToolsMcpEnv(undefined)).toEqual({});
  });
});
