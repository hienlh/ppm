import { describe, expect, it } from "bun:test";
import {
  CLAUDE_SESSION_COLLAB_TOOLS, sessionCollabMcpServers, tabToolsMcpServers, withSessionTokenMasked,
} from "../../../src/providers/claude-agent-sdk-query-options.ts";
import { buildThreadParams, sessionCollabMcpEnv } from "../../../src/providers/codex-app-server/codex-thread-params.ts";
import { spawnFingerprint } from "../../../src/providers/claude-warm-spare.ts";
import { hiddenBuiltinCronTools } from "../../../src/providers/claude-builtin-cron.ts";
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

  it("gives Claude one http server with that timeout, its tools and the manager's report tool pre-approved", () => {
    expect(sessionCollabMcpServers(undefined)).toEqual({});
    expect(sessionCollabMcpServers(access)).toEqual({
      "ppm-sessions": { type: "http", url: access.url, headers: { Authorization: "Bearer collab-secret" }, timeout: SESSION_COLLAB_TOOLS_TIMEOUT_MS },
    });
    expect(CLAUDE_SESSION_COLLAB_TOOLS).toEqual([
      "mcp__ppm-sessions__create_session", "mcp__ppm-sessions__send_to_session", "mcp__ppm-sessions__session_status", "mcp__ppm-sessions__design_screenshot",
      "mcp__ppm-sessions__session_schedule_create", "mcp__ppm-sessions__session_schedule_list", "mcp__ppm-sessions__session_schedule_delete",
      "mcp__ppm-sessions__session_schedule_set_enabled", "mcp__ppm-sessions__session_schedule_propose_script", "mcp__ppm-sessions__session_schedule_claim",
      "mcp__ppm-sessions__report_to_assistant", "mcp__ppm-sessions__report_withdraw",
      "mcp__ppm-sessions__vault_list", "mcp__ppm-sessions__vault_read", "mcp__ppm-sessions__vault_propose",
      "mcp__ppm-sessions__ppm_task_list", "mcp__ppm-sessions__ppm_task_get", "mcp__ppm-sessions__ppm_task_project",
      "mcp__ppm-sessions__ppm_task_create", "mcp__ppm-sessions__ppm_task_update", "mcp__ppm-sessions__ppm_task_close",
      "mcp__ppm-sessions__ppm_task_reorder", "mcp__ppm-sessions__ppm_task_undo", "mcp__ppm-sessions__ppm_task_project_update",
      "mcp__ppm-sessions__ppm_task_notify_manager",
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
      url: access.url, bearer_token_env_var: "PPM_SESSIONS_MCP_TOKEN",
      enabled_tools: ["create_session", "send_to_session", "session_status", "design_screenshot", "session_schedule_create", "session_schedule_list", "session_schedule_delete", "session_schedule_set_enabled", "session_schedule_propose_script", "session_schedule_claim", "vault_list", "vault_read", "vault_propose",
        "ppm_task_list", "ppm_task_get", "ppm_task_project", "ppm_task_create", "ppm_task_update", "ppm_task_close", "ppm_task_reorder",
        "ppm_task_undo", "ppm_task_project_update", "ppm_task_notify_manager"],
      default_tools_approval_mode: "approve", startup_timeout_sec: 10, tool_timeout_sec: Math.ceil(SESSION_COLLAB_TOOLS_TIMEOUT_MS / 1000),
    });
    expect(JSON.stringify(params)).not.toContain("collab-secret");
    expect(sessionCollabMcpEnv(access)).toEqual({ PPM_SESSIONS_MCP_TOKEN: "collab-secret" });
    expect(sessionCollabMcpEnv(undefined)).toEqual({});
  });

  describe("Claude's own cron tools", () => {
    const on = { ppm_tools: { session_schedule_create: true } };

    it("are hidden only while the chat has PPM's schedule tool and the setting asks for it", () => {
      expect(hiddenBuiltinCronTools(on, true)).toEqual(["CronCreate", "CronList", "CronDelete"]);
      expect(hiddenBuiltinCronTools({ ...on, hide_builtin_cron: true }, true)).toEqual(["CronCreate", "CronList", "CronDelete"]);
      expect(hiddenBuiltinCronTools({ ...on, hide_builtin_cron: false }, true)).toEqual([]);
      // No server attached (a design session, minimal mode, the PPM Assistant): nothing replaces them.
      expect(hiddenBuiltinCronTools(on, false)).toEqual([]);
      expect(hiddenBuiltinCronTools({ ppm_tools: { session_schedule_create: false } }, true)).toEqual([]);
    });

    it("are kept, as the schedule tool is off, until the user answers the feature's own question", () => {
      expect(hiddenBuiltinCronTools({}, true)).toEqual([]);
      // Turning the session-collaboration feature on says nothing about schedules.
      expect(hiddenBuiltinCronTools({ ppm_tools: { create_session: true, search_sessions: true } }, true)).toEqual([]);
    });

    it("leaves ScheduleWakeup alone, so /loop keeps working", () => {
      expect(hiddenBuiltinCronTools(on, true)).not.toContain("ScheduleWakeup");
    });
  });
});
