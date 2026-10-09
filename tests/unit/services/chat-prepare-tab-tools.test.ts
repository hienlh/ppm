import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { configService } from "../../../src/services/config.service.ts";
import { getDb, setSessionDesignSlug } from "../../../src/services/db.service.ts";
import { setServerListenAddress } from "../../../src/services/server-listen-address.ts";
import { tabToolsMcpTokens } from "../../../src/services/tab-tools-mcp/tab-tools-mcp-tokens.ts";
import { TAB_TOOLS } from "../../../src/shared/ppm-tools.ts";
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
const ALL_TAB_TOOLS_OFF = Object.fromEntries(TAB_TOOLS.map((tool) => [tool, false]));

describe("chatService tab tools", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM session_metadata");
    providerRegistry.register(stubProvider("stub-tabs"));
    setServerListenAddress(8124, "0.0.0.0");
  });
  afterEach(() => {
    setTabTools(undefined);
    delete (configService as any).config.ai.ppm_tools;
    setServerListenAddress(0, "");
  });

  it("gives an ordinary chat the tab tools while any of them is on, and never a caller's endpoint", async () => {
    // open_url and the terminal tools are on until switched off; the older switch covers only the first two.
    const opts = await chatService.prepareSendOptions("stub-tabs", "t1", "hi", EVIL);
    expect(opts.tabToolsMcp?.url).toBe("http://127.0.0.1:8124/api/tab-tools-mcp");
    expect(opts.tabToolsMcp?.token).not.toBe("stolen");
    expect(tabToolsMcpTokens.resolve(opts.tabToolsMcp!.token)).toEqual({ sessionId: "t1" });
    // A running Claude query keeps the MCP config it started with, so the token holds.
    expect((await chatService.prepareSendOptions("stub-tabs", "t1", "again")).tabToolsMcp?.token).toBe(opts.tabToolsMcp!.token);
    (configService as any).config.ai.ppm_tools = ALL_TAB_TOOLS_OFF;
    expect(await chatService.prepareSendOptions("stub-tabs", "t1", "hi", EVIL)).not.toHaveProperty("tabToolsMcp");
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

  it("gives the tab tools while one is on by its own switch, which wins over the older one", async () => {
    const ai = (configService as any).config.ai;
    ai.ppm_tools = { ...ALL_TAB_TOOLS_OFF, open_preview: true };
    expect((await chatService.prepareSendOptions("stub-tabs", "t5", "hi")).tabToolsMcp?.url).toBe("http://127.0.0.1:8124/api/tab-tools-mcp");
    ai.ppm_tools = { ...ALL_TAB_TOOLS_OFF, read_terminal: true };
    expect((await chatService.prepareSendOptions("stub-tabs", "t5", "hi")).tabToolsMcp?.url).toBe("http://127.0.0.1:8124/api/tab-tools-mcp");
    setTabTools(true);
    ai.ppm_tools = ALL_TAB_TOOLS_OFF;
    expect(await chatService.prepareSendOptions("stub-tabs", "t5", "hi")).not.toHaveProperty("tabToolsMcp");
  });

  it("revokes the token when the chat is deleted", async () => {
    setTabTools(true);
    const { tabToolsMcp } = await chatService.prepareSendOptions("stub-tabs", "t4", "hi");
    expect(tabToolsMcpTokens.resolve(tabToolsMcp!.token)).not.toBeNull();
    await chatService.deleteSession("stub-tabs", "t4");
    expect(tabToolsMcpTokens.resolve(tabToolsMcp!.token)).toBeNull();
  });
});
