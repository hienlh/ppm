import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { configService } from "../../../src/services/config.service.ts";
import { getDb, setSessionDesignSlug } from "../../../src/services/db.service.ts";
import { setServerListenAddress } from "../../../src/services/server-listen-address.ts";
import { tabToolsMcpTokens } from "../../../src/services/tab-tools-mcp/tab-tools-mcp-tokens.ts";
import type { AIProvider, SendMessageOpts } from "../../../src/types/chat.ts";

function stubProvider(id: string): AIProvider {
  return {
    id, name: id, supportsDesignInstructions: true,
    async createSession() { return { id: "x", providerId: id, title: "", createdAt: "" }; },
    async resumeSession() { return { id: "x", providerId: id, title: "", createdAt: "" }; },
    async listSessions() { return []; },
    async deleteSession() {},
    async *sendMessage(_s: string, _m: string, _o?: SendMessageOpts) {},
  };
}

const EVIL = { tabToolsMcp: { url: "http://evil.example/mcp", token: "stolen" } };
const setTabTools = (on: boolean | undefined) => { (configService as any).config.ai.tab_tools = on; };

describe("chatService tab tools", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM session_metadata");
    providerRegistry.register(stubProvider("stub-tabs"));
    setServerListenAddress(8124, "0.0.0.0");
  });
  afterEach(() => {
    setTabTools(undefined);
    setServerListenAddress(0, "");
  });

  it("gives an ordinary chat the tab tools only while the setting is on, and never a caller's endpoint", async () => {
    expect(await chatService.prepareSendOptions("stub-tabs", "t1", "hi", EVIL)).not.toHaveProperty("tabToolsMcp");
    setTabTools(true);
    const opts = await chatService.prepareSendOptions("stub-tabs", "t1", "hi", EVIL);
    expect(opts.tabToolsMcp?.url).toBe("http://127.0.0.1:8124/api/tab-tools-mcp");
    expect(opts.tabToolsMcp?.token).not.toBe("stolen");
    expect(tabToolsMcpTokens.resolve(opts.tabToolsMcp!.token)).toEqual({ sessionId: "t1" });
    // A running Claude query keeps the MCP config it started with, so the token holds.
    expect((await chatService.prepareSendOptions("stub-tabs", "t1", "again")).tabToolsMcp?.token).toBe(opts.tabToolsMcp!.token);
    setTabTools(false);
    expect(await chatService.prepareSendOptions("stub-tabs", "t1", "hi")).not.toHaveProperty("tabToolsMcp");
  });

  it("leaves a design session to design_check, and offers nothing when the server does not listen", async () => {
    setTabTools(true);
    setSessionDesignSlug("t2", "smoke");
    const design = await chatService.prepareSendOptions("stub-tabs", "t2", "hi");
    expect(design.designSession).toBe(true);
    expect(design).not.toHaveProperty("tabToolsMcp");
    setServerListenAddress(0, "");
    expect(await chatService.prepareSendOptions("stub-tabs", "t3", "hi")).not.toHaveProperty("tabToolsMcp");
  });

  it("revokes the token when the chat is deleted", async () => {
    setTabTools(true);
    const { tabToolsMcp } = await chatService.prepareSendOptions("stub-tabs", "t4", "hi");
    expect(tabToolsMcpTokens.resolve(tabToolsMcp!.token)).not.toBeNull();
    await chatService.deleteSession("stub-tabs", "t4");
    expect(tabToolsMcpTokens.resolve(tabToolsMcp!.token)).toBeNull();
  });
});
