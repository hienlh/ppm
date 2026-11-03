import { describe, expect, test } from "bun:test";
import { isMinimalMode, isMinimalPathDisabled } from "../../../src/services/runtime-mode.ts";
import { buildExecCommand, generatePlist, generateSystemdService, generateVbsWrapper } from "../../../src/services/autostart-generator.ts";

describe("minimal runtime mode", () => {
  test("requires an explicit process flag", () => {
    expect(isMinimalMode(["bun", "ppm", "start"])).toBe(false);
    expect(isMinimalMode(["bun", "ppm", "start", "--minimal"])).toBe(true);
    expect(isMinimalMode(["ppm", "__serve__", "0", "127.0.0.1", "dev", "--minimal"])).toBe(true);
    expect(isMinimalMode(["ppm", "start", "--minimal=false"])).toBe(false);
  });

  test("keeps chat, files, accounts and core connections available", () => {
    for (const path of ["/api/info", "/api/auth/check", "/api/projects", "/api/accounts", "/api/project/demo/chat", "/api/project/demo/files", "/api/project/demo/workspace", "/api/ai-resources", "/api/tunnel", "/api/tunnel/named", "/api/cloud", "/api/tailscale", "/api/fs/browse", "/api/fs/upload", "/api/teams", "/ws/global", "/ws/health", "/ws/project/my%20project/chat/session-id"]) {
      expect(isMinimalPathDisabled(path)).toBe(false);
    }
  });

  test("rejects workspace sockets and APIs including nested actions", () => {
    for (const path of ["/ws/extensions", "/ws/remote-desktop", "/ws/project/demo/terminal/1", "/ws/project/demo/lsp", "/ws/project/demo/group/1", "/api/tunnels", "/api/tunnels/transports", "/api/preview/start", "/api/db/connections/file/objects", "/api/extensions/install", "/api/db/connections", "/api/project/demo/designs", "/api/project/demo/git/status", "/api/schedules/run", "/api/settings/clawbot/telegram/connect", "/proxy/v1/messages", "/api/tab-tools-mcp", "/api/db-tools-mcp"]) {
      expect(isMinimalPathDisabled(path)).toBe(true);
    }
  });

  test("service-manager restarts preserve minimal mode and profile", () => {
    const config = { port: 3210, host: "127.0.0.1", share: true, profile: "dev", minimal: true };
    const args = buildExecCommand(config);
    expect(args.slice(args.indexOf("__supervise__"))).toEqual(["__supervise__", "3210", "127.0.0.1", "dev", "--share", "--minimal"]);
    expect(generatePlist(config)).toContain("--minimal");
    expect(generateSystemdService(config)).toContain("--minimal");
    expect(generateVbsWrapper(config)).toContain("--minimal");
    expect(buildExecCommand({ ...config, minimal: false })).not.toContain("--minimal");
  });
});
