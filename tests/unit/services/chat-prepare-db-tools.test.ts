import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { getDb, insertConnection, setSessionDesignSlug, updateConnection } from "../../../src/services/db.service.ts";
import { setServerListenAddress } from "../../../src/services/server-listen-address.ts";
import { dbToolsMcpTokens } from "../../../src/services/db-ai-tools/db-ai-tools-tokens.ts";
import { dbApprovalBroker, setDbApprovalChat } from "../../../src/services/db-ai-tools/db-approval-broker.ts";
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

const EVIL = { dbToolsMcp: { url: "http://evil.example/mcp", token: "stolen" } };

describe("chatService database tools", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM session_metadata");
    getDb().run("DELETE FROM connections");
    providerRegistry.register(stubProvider("stub-db"));
    setServerListenAddress(8124, "0.0.0.0");
  });
  afterEach(() => {
    setServerListenAddress(0, "");
    setDbApprovalChat(null);
  });

  it("gives a chat the database tools while a connection is available to the AI, and never a caller's endpoint", async () => {
    expect(await chatService.prepareSendOptions("stub-db", "d1", "hi", EVIL)).not.toHaveProperty("dbToolsMcp");
    const conn = insertConnection("sqlite", "Prod", { type: "sqlite", path: "/tmp/x.db" });
    const opts = await chatService.prepareSendOptions("stub-db", "d1", "hi", EVIL);
    expect(opts.dbToolsMcp?.url).toBe("http://127.0.0.1:8124/api/db-tools-mcp");
    expect(opts.dbToolsMcp?.token).not.toBe("stolen");
    expect(dbToolsMcpTokens.resolve(opts.dbToolsMcp!.token)).toEqual({ sessionId: "d1" });
    expect((await chatService.prepareSendOptions("stub-db", "d1", "again")).dbToolsMcp?.token).toBe(opts.dbToolsMcp!.token);
    // "Available to the AI chat" off on the only connection: no tools to offer.
    updateConnection(conn.id, { aiAccess: 0 });
    expect(await chatService.prepareSendOptions("stub-db", "d1", "hi")).not.toHaveProperty("dbToolsMcp");
  });

  it("offers no database tools while the user has all three off", async () => {
    insertConnection("sqlite", "Prod", { type: "sqlite", path: "/tmp/x.db" });
    const ai = (configService as any).config.ai;
    try {
      ai.ppm_tools = { db_query: false, open_query: false, db_execute: false };
      expect(await chatService.prepareSendOptions("stub-db", "d5", "hi")).not.toHaveProperty("dbToolsMcp");
      ai.ppm_tools = { db_query: false, open_query: false };
      expect((await chatService.prepareSendOptions("stub-db", "d5", "hi")).dbToolsMcp?.url).toBe("http://127.0.0.1:8124/api/db-tools-mcp");
    } finally {
      delete ai.ppm_tools;
    }
  });

  it("leaves a design session out, and offers nothing when the server does not listen", async () => {
    insertConnection("sqlite", "Prod", { type: "sqlite", path: "/tmp/x.db" });
    setSessionDesignSlug("d2", "smoke");
    const design = await chatService.prepareSendOptions("stub-db", "d2", "hi");
    expect(design.designSession).toBe(true);
    expect(design).not.toHaveProperty("dbToolsMcp");
    setServerListenAddress(0, "");
    expect(await chatService.prepareSendOptions("stub-db", "d3", "hi")).not.toHaveProperty("dbToolsMcp");
  });

  it("revokes the token and declines a waiting change when the chat is deleted", async () => {
    insertConnection("sqlite", "Prod", { type: "sqlite", path: "/tmp/x.db" });
    const { dbToolsMcp } = await chatService.prepareSendOptions("stub-db", "d4", "hi");
    setDbApprovalChat({ announce: () => true, resolved: () => {} });
    const waiting = dbApprovalBroker.request("d4", {
      connectionId: 1, connectionName: "Prod", dbType: "sqlite", group: null, color: null, readonly: true, sql: "DELETE FROM t", reason: "r",
    });
    await chatService.deleteSession("stub-db", "d4");
    expect(dbToolsMcpTokens.resolve(dbToolsMcp!.token)).toBeNull();
    expect(await waiting).toMatchObject({ approved: false, reason: "cancelled" });
  });
});
