/**
 * When a turn gets the `ppm-ext` server: minted by `chatService.prepareSendOptions` from the
 * session's binding (never from the caller), kept for the life of the query, and revoked when
 * the chat is deleted, unbound with no query holding it, or its extension removed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import { getDb, insertExtensionSessionBinding } from "../../../src/services/db.service.ts";
import { bindSession } from "../../../src/services/extension-session-binding.service.ts";
import { extensionMcpTokens } from "../../../src/services/extension-mcp/extension-mcp-tokens.ts";
import { extensionApiDeps, registerExtensionApiHandlers } from "../../../src/services/extension-api/index.ts";
import { RpcChannel } from "../../../src/services/extension-rpc.ts";
import { setServerListenAddress } from "../../../src/services/server-listen-address.ts";
import type { AIProvider } from "../../../src/types/chat.ts";
import type { RpcMessage, RpcResponse } from "../../../src/types/extension.ts";

const EXT = "probe-ext";
const PROVIDER = "stub-ext-mcp";

const provider: AIProvider = {
  id: PROVIDER, name: PROVIDER, supportsExtensionBinding: true,
  async createSession() { return { id: "x", providerId: PROVIDER, title: "", createdAt: "" }; },
  async resumeSession() { return { id: "x", providerId: PROVIDER, title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage(sessionId: string) { yield { type: "done" as const, sessionId }; },
};

const sent: RpcMessage[] = [];
const channel = new RpcChannel((msg) => sent.push(msg));
registerExtensionApiHandlers(channel, extensionApiDeps(1));
let nextId = 1;
async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = nextId++;
  await channel.handleMessage({ type: "request", id, method, params: [params] });
  const response = sent.find((m) => m.type === "response" && m.id === id) as RpcResponse;
  if (response.error) throw new Error(response.error);
  return response.result;
}

function bound(sessionId: string, toolsets: string[]) {
  insertExtensionSessionBinding(sessionId, EXT);
  bindSession(sessionId, EXT, { toolsets });
}

const prepare = (sessionId: string, extra: Record<string, unknown> = {}) =>
  chatService.prepareSendOptions(PROVIDER, sessionId, "hi", { permissionMode: "default", ...extra });

describe("the ppm-ext server on a chat turn", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM extension_session_bindings");
    providerRegistry.register(provider);
    setServerListenAddress(8126, "127.0.0.1");
  });
  afterEach(() => setServerListenAddress(0, ""));

  it("is minted from the binding even before any toolset registered, and kept across turns", async () => {
    bound("fg-chat", ["fg"]);
    const first = await prepare("fg-chat");
    expect(first.extensionMcp?.url).toBe("http://127.0.0.1:8126/api/ext-mcp");
    expect(extensionMcpTokens.resolve(first.extensionMcp!.token)).toEqual({ sessionId: "fg-chat", extensionId: EXT });
    // A changed toolset list keeps the token: the live query holds it.
    bindSession("fg-chat", EXT, { toolsets: ["fg", "ab"] });
    expect((await prepare("fg-chat")).extensionMcp?.token).toBe(first.extensionMcp!.token);
  });

  it("never comes from the caller, and not for a chat bound without toolsets", async () => {
    const forged = { extensionMcp: { url: "http://evil.example/mcp", token: "x" } };
    expect(await prepare("plain", forged)).not.toHaveProperty("extensionMcp");
    insertExtensionSessionBinding("words", EXT);
    bindSession("words", EXT, { instructions: "# Notes" });
    expect(await prepare("words", forged)).not.toHaveProperty("extensionMcp");
  });

  it("is absent in a process that serves no HTTP", async () => {
    setServerListenAddress(0, "");
    bound("cli-chat", ["fg"]);
    expect(await prepare("cli-chat")).not.toHaveProperty("extensionMcp");
  });

  it("is revoked when the chat is deleted", async () => {
    bound("deleted-chat", ["fg"]);
    const { extensionMcp } = await prepare("deleted-chat");
    await chatService.deleteSession(PROVIDER, "deleted-chat");
    expect(extensionMcpTokens.resolve(extensionMcp!.token)).toBeNull();
  });

  it("is revoked by an unbind when no query holds it, and a later bind gets a fresh one", async () => {
    bound("unbound-chat", ["fg"]);
    const { extensionMcp } = await prepare("unbound-chat");
    expect(await rpc("chat:unbind", { sessionId: "unbound-chat", extensionId: EXT })).toEqual({ unbound: true, pendingRestart: false });
    expect(extensionMcpTokens.resolve(extensionMcp!.token)).toBeNull();
    expect(await prepare("unbound-chat")).not.toHaveProperty("extensionMcp");
    bindSession("unbound-chat", EXT, { toolsets: ["fg"] });
    const again = (await prepare("unbound-chat")).extensionMcp!;
    expect(again.token).not.toBe(extensionMcp!.token);
  });
});
