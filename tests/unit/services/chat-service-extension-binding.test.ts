/**
 * What a session's binding does to a turn's options, through `chatService` and a stub provider
 * that records what it was handed: instructions and policy are server-built, a policy session
 * runs outside bypass with no tab or database tools, and a provider that cannot enforce a
 * binding never runs a bound session.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { getDb, insertConnection, insertExtensionSessionBinding } from "../../../src/services/db.service.ts";
import { bindSession } from "../../../src/services/extension-session-binding.service.ts";
import { setServerListenAddress } from "../../../src/services/server-listen-address.ts";
import type { AIProvider, SendMessageOpts } from "../../../src/types/chat.ts";

const EXT = "probe-ext";
const POLICY = { readRoots: ["/r"], writeRoots: ["/r/.proposals"] };
const recorded: SendMessageOpts[] = [];

function stubProvider(id: string, supportsExtensionBinding: boolean): AIProvider {
  return {
    id, name: id, supportsExtensionBinding,
    async createSession() { return { id: "x", providerId: id, title: "", createdAt: "" }; },
    async resumeSession() { return { id: "x", providerId: id, title: "", createdAt: "" }; },
    async listSessions() { return []; },
    async deleteSession() {},
    async *sendMessage(sessionId: string, _m: string, opts?: SendMessageOpts) {
      recorded.push(opts ?? {});
      yield { type: "done" as const, sessionId };
    },
  };
}

function bound(sessionId: string, binding: Record<string, unknown>) {
  insertExtensionSessionBinding(sessionId, EXT);
  bindSession(sessionId, EXT, binding);
}

const CALLER = {
  extensionInstructions: "injected by a caller",
  extensionToolPolicy: { readRoots: ["/"], writeRoots: ["/"] },
};

describe("chatService and extension bindings", () => {
  beforeEach(() => {
    recorded.length = 0;
    getDb().run("DELETE FROM extension_session_bindings");
    getDb().run("DELETE FROM connections");
    providerRegistry.register(stubProvider("stub-bind", true));
    providerRegistry.register(stubProvider("stub-nobind", false));
    // Tab and database tools would otherwise be attached to every ordinary chat here.
    setServerListenAddress(8125, "0.0.0.0");
    insertConnection("sqlite", "Prod", { type: "sqlite", path: "/tmp/x.db" });
  });
  afterEach(async () => {
    setServerListenAddress(0, "");
    const { registerDbApprovalChat } = await import("../../../src/server/ws/chat.ts");
    registerDbApprovalChat();
  });

  it("discards a caller's binding fields on an unbound session, which keeps its tools and mode", async () => {
    const opts = await chatService.prepareSendOptions("stub-bind", "plain", "hi", { ...CALLER, permissionMode: "bypassPermissions" });
    expect(opts).not.toHaveProperty("extensionInstructions");
    expect(opts).not.toHaveProperty("extensionToolPolicy");
    expect(opts.permissionMode).toBe("bypassPermissions");
    expect(opts.tabToolsMcp).toBeDefined();
    expect(opts.dbToolsMcp).toBeDefined();
  });

  it("gives a policy session its instructions and policy, no tab or database tools, and no bypass", async () => {
    bound("bound", { instructions: "# Manager", toolsets: ["fg"], toolPolicy: POLICY });
    const opts = await chatService.prepareSendOptions("stub-bind", "bound", "hi", { ...CALLER, permissionMode: "bypassPermissions" });
    expect(opts.extensionInstructions).toBe("# Manager");
    expect(opts.extensionToolPolicy).toEqual(POLICY);
    expect(opts.permissionMode).toBe("acceptEdits");
    expect(opts).not.toHaveProperty("tabToolsMcp");
    expect(opts).not.toHaveProperty("dbToolsMcp");

    expect((await chatService.prepareSendOptions("stub-bind", "bound", "hi")).permissionMode).toBe("acceptEdits");
    expect((await chatService.prepareSendOptions("stub-bind", "bound", "hi", { permissionMode: "default" })).permissionMode).toBe("default");
    expect((await chatService.prepareSendOptions("stub-bind", "bound", "hi", { permissionMode: "plan" })).permissionMode).toBe("plan");
  });

  it("delivers the binding to the provider on a turn, whoever sent it", async () => {
    bound("turn", { instructions: "# Manager", toolPolicy: POLICY });
    for await (const _ of chatService.sendMessage("stub-bind", "turn", "hi", { ...CALLER, permissionMode: "bypassPermissions", origin: "ws" })) { /* consume */ }
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ extensionInstructions: "# Manager", extensionToolPolicy: POLICY, permissionMode: "acceptEdits" });
    expect(recorded[0]).not.toHaveProperty("tabToolsMcp");
  });

  it("adds instructions alone without touching the mode or the tools", async () => {
    bound("words", { instructions: "# Notes" });
    const opts = await chatService.prepareSendOptions("stub-bind", "words", "hi", { permissionMode: "bypassPermissions" });
    expect(opts.extensionInstructions).toBe("# Notes");
    expect(opts).not.toHaveProperty("extensionToolPolicy");
    expect(opts.permissionMode).toBe("bypassPermissions");
    expect(opts.tabToolsMcp).toBeDefined();
  });

  it("treats a session whose binding was cleared as unbound", async () => {
    bound("cleared", { instructions: "# Manager", toolPolicy: POLICY });
    bindSession("cleared", EXT, { instructions: null, toolPolicy: null });
    const opts = await chatService.prepareSendOptions("stub-bind", "cleared", "hi", { permissionMode: "bypassPermissions" });
    expect(opts).not.toHaveProperty("extensionToolPolicy");
    expect(opts.permissionMode).toBe("bypassPermissions");
  });

  it("refuses a bound session on a provider that cannot enforce a binding", async () => {
    bound("elsewhere", { toolPolicy: POLICY });
    await expect(chatService.prepareSendOptions("stub-nobind", "elsewhere", "hi")).rejects.toThrow("only Claude can run it");
    // An empty binding binds nothing, so it does not stand in the way.
    insertExtensionSessionBinding("empty", EXT);
    expect(await chatService.prepareSendOptions("stub-nobind", "empty", "hi")).not.toHaveProperty("extensionToolPolicy");
  });

  it("removes the binding when the chat is deleted", async () => {
    bound("gone", { toolPolicy: POLICY });
    await chatService.deleteSession("stub-bind", "gone");
    expect(getDb().query("SELECT COUNT(*) AS n FROM extension_session_bindings WHERE session_id = 'gone'").get()).toEqual({ n: 0 });
  });
});
