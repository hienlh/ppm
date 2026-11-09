/**
 * `ppm start --minimal` runs chat, files, the editor and Settings only, so a chat gets none of
 * PPM's own MCP servers — the session tools included — whatever Settings → Tools says.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { configService } from "../../../src/services/config.service.ts";
import { getDb } from "../../../src/services/db.service.ts";
import { setServerListenAddress } from "../../../src/services/server-listen-address.ts";
import { SESSION_TOOLS } from "../../../src/shared/ppm-tools.ts";
import type { AIProvider, SendMessageOpts } from "../../../src/types/chat.ts";

function stubProvider(id: string): AIProvider {
  return {
    id, name: id,
    async createSession() { return { id: "x", providerId: id, title: "", createdAt: "" }; },
    async resumeSession() { return { id: "x", providerId: id, title: "", createdAt: "" }; },
    async listSessions() { return []; },
    async deleteSession() {},
    async *sendMessage(_s: string, _m: string, _o?: SendMessageOpts) {},
  };
}

const EVIL = { sessionCollabMcp: { url: "http://evil.example/mcp", token: "stolen" } };

beforeEach(() => {
  getDb().run("DELETE FROM session_metadata");
  providerRegistry.register(stubProvider("stub-sessions"));
  setServerListenAddress(8125, "0.0.0.0");
  configService.get("ai").ppm_tools = Object.fromEntries(SESSION_TOOLS.map((tool) => [tool, true]));
});
afterEach(() => {
  delete (configService as any).config.ai.ppm_tools;
  setServerListenAddress(0, "");
});

it("minimal mode attaches no session tools even with every one switched on, and keeps the switches", async () => {
  const ai = configService.get("ai");
  const argv = process.argv;
  process.argv = [...argv, "--minimal"];
  try {
    expect(await chatService.prepareSendOptions("stub-sessions", "minimal-sessions", "hi", EVIL as SendMessageOpts))
      .not.toHaveProperty("sessionCollabMcp");
    expect(SESSION_TOOLS.every((tool) => ai.ppm_tools?.[tool] === true)).toBe(true);
  } finally { process.argv = argv; }
  const full = await chatService.prepareSendOptions("stub-sessions", "minimal-sessions", "hi");
  expect(full.sessionCollabMcp?.url).toBe("http://127.0.0.1:8125/api/sessions-mcp");
});
