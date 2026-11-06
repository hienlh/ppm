import { describe, expect, it } from "bun:test";
import {
  CLAUDE_SESSION_COLLAB_TOOLS, sessionCollabMcpServers, tabToolsMcpServers, withSessionTokenMasked,
} from "../../../src/providers/claude-agent-sdk-query-options.ts";
import { buildThreadParams, sessionCollabMcpEnv } from "../../../src/providers/codex-app-server/codex-thread-params.ts";
import { spawnFingerprint } from "../../../src/providers/claude-warm-spare.ts";
import {
  COLLAB_APPROVAL_WAIT_MS, SESSION_COLLAB_TOOLS_TIMEOUT_MS,
} from "../../../src/services/session-collab/session-collab-tool.ts";
import { SESSION_COLLAB_LIMITS } from "../../../src/shared/session-collab-settings.ts";

const access = { url: "http://127.0.0.1:8080/api/sessions-mcp", token: "collab-secret" };
const permission = { sandbox: "workspace-write", approvalPolicy: "never" } as any;

describe("session tools provider options", () => {
  it("times a call out only after the longest wait the settings allow, plus an approval", () => {
    expect(SESSION_COLLAB_TOOLS_TIMEOUT_MS).toBeGreaterThan(SESSION_COLLAB_LIMITS.waitTimeoutMinutes.max * 60_000 + COLLAB_APPROVAL_WAIT_MS);
  });

  it("gives Claude one http server with that timeout, its three tools pre-approved", () => {
    expect(sessionCollabMcpServers(undefined)).toEqual({});
    expect(sessionCollabMcpServers(access)).toEqual({
      "ppm-sessions": { type: "http", url: access.url, headers: { Authorization: "Bearer collab-secret" }, timeout: SESSION_COLLAB_TOOLS_TIMEOUT_MS },
    });
    expect(CLAUDE_SESSION_COLLAB_TOOLS).toEqual([
      "mcp__ppm-sessions__create_session", "mcp__ppm-sessions__send_to_session", "mcp__ppm-sessions__session_status",
    ]);
  });

  it("lets a warm spare match its session's turns whatever the session tools' token is", () => {
    const options = (tabs: string, sessions: string) => ({
      cwd: "/p",
      mcpServers: { ...tabToolsMcpServers({ url: "http://t", token: tabs }), ...sessionCollabMcpServers({ ...access, token: sessions }) },
    });
    expect(spawnFingerprint(withSessionTokenMasked(options("", "")))).toBe(spawnFingerprint(withSessionTokenMasked(options("t1", "s1"))));
    const real = options("t1", "s1");
    withSessionTokenMasked(real);
    expect(real.mcpServers["ppm-sessions"]!.headers).toEqual({ Authorization: "Bearer s1" });
  });

  it("gives Codex an approved mcp_servers override with the token only in the environment", () => {
    const params = buildThreadParams({ cwd: "/p", permission, sessionCollabMcp: access });
    expect(params.config!["mcp_servers.ppm_sessions"]).toEqual({
      url: access.url, bearer_token_env_var: "PPM_SESSIONS_MCP_TOKEN", enabled_tools: ["create_session", "send_to_session", "session_status"],
      default_tools_approval_mode: "approve", startup_timeout_sec: 10, tool_timeout_sec: Math.ceil(SESSION_COLLAB_TOOLS_TIMEOUT_MS / 1000),
    });
    expect(JSON.stringify(params)).not.toContain("collab-secret");
    expect(sessionCollabMcpEnv(access)).toEqual({ PPM_SESSIONS_MCP_TOKEN: "collab-secret" });
    expect(sessionCollabMcpEnv(undefined)).toEqual({});
  });
});
