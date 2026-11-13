/**
 * Session bindings through the real RPC handlers and the real database: who may bind what,
 * what a bind stores, and that no row outlives its session or its extension.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { RpcChannel } from "../../../src/services/extension-rpc.ts";
import { registerExtensionApiHandlers, extensionApiDeps } from "../../../src/services/extension-api/index.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { configService } from "../../../src/services/config.service.ts";
import {
  CURRENT_SCHEMA_VERSION, deleteExtension, getDb, getExtensionSessionBinding, getSessionCreatedByExtension,
  insertExtensionSessionBinding, openTestDb, setSessionMigratedTo, setSessionProvider,
} from "../../../src/services/db.service.ts";
import { sessionBindingFor } from "../../../src/services/extension-session-binding.service.ts";
import type { ExtensionSessionBinding } from "../../../src/shared/extension-session-binding.ts";
import type { RpcMessage, RpcResponse } from "../../../src/types/extension.ts";

const PROJECT = "ext-binding-project";
const PROJECT_PATH = `${process.cwd()}/.ext-binding-${process.pid}`;
const EXT = "probe-ext";
const OTHER = "other-ext";
const POLICY = { readRoots: ["/r"], writeRoots: ["/r/.proposals"], allowTools: ["TodoWrite"] };

const sent: RpcMessage[] = [];
const channel = new RpcChannel((msg) => sent.push(msg));
registerExtensionApiHandlers(channel, extensionApiDeps(1));
let nextId = 1;

async function call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = nextId++;
  await channel.handleMessage({ type: "request", id, method, params: [params] });
  const response = sent.find((m) => m.type === "response" && m.id === id) as RpcResponse | undefined;
  if (!response) throw new Error(`no response for ${method}`);
  if (response.error) throw new Error(response.error);
  return response.result as T;
}

const create = (extensionId = EXT, bindable = true, providerId = "claude") =>
  call<{ sessionId: string }>("chat:createSession", { extensionId, projectName: PROJECT, providerId, bindable });
const bind = (sessionId: string, binding: unknown, extensionId = EXT) =>
  call<ExtensionSessionBinding>("chat:bind", { sessionId, extensionId, binding });

beforeAll(() => {
  const projects = configService.get("projects").filter((p) => p.name !== PROJECT);
  configService.set("projects", [...projects, { name: PROJECT, path: PROJECT_PATH }]);
});
afterAll(() => {
  configService.set("projects", configService.get("projects").filter((p) => p.name !== PROJECT));
});

describe("schema", () => {
  it("creates both extension tables and ends at the current version", () => {
    const db = openTestDb();
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain("extension_session_bindings");
    expect(tables).toContain("extension_mcp_toolsets");
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    expect(CURRENT_SCHEMA_VERSION).toBe(71);
    const columns = (db.query("PRAGMA table_info(extension_session_bindings)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain("extension_removed_at");
  });
});

describe("chat:createSession bindable / chat:bind / chat:getBinding / chat:unbind", () => {
  it("binds a Claude session the extension created as bindable, field by field", async () => {
    const { sessionId } = await create();
    expect(getExtensionSessionBinding(sessionId)).toMatchObject({ extension_id: EXT, instructions: null, toolsets_json: "[]", tool_policy_json: null });

    const first = await bind(sessionId, { instructions: "# Manager", toolsets: ["fg"], toolPolicy: POLICY });
    expect(first).toMatchObject({ sessionId, extensionId: EXT, instructions: "# Manager", toolsets: ["fg"], toolPolicy: POLICY });
    // A field left out keeps its value; null clears it.
    expect(await bind(sessionId, { instructions: "# Manager v2" })).toMatchObject({ instructions: "# Manager v2", toolsets: ["fg"], toolPolicy: POLICY });
    expect(await bind(sessionId, { toolPolicy: null })).toMatchObject({ instructions: "# Manager v2", toolPolicy: null });
    expect(await call("chat:getBinding", { sessionId, extensionId: EXT })).toMatchObject({ instructions: "# Manager v2", toolsets: ["fg"] });

    await call("chat:unbind", { sessionId, extensionId: EXT });
    expect(await call("chat:getBinding", { sessionId, extensionId: EXT })).toMatchObject({ instructions: null, toolsets: [], toolPolicy: null });
    // Still the extension's: it can bind again.
    expect(await bind(sessionId, { toolPolicy: POLICY })).toMatchObject({ toolPolicy: POLICY });
  });

  it("refuses a session the extension did not create as bindable", async () => {
    const { sessionId } = await create();
    await expect(bind(sessionId, { instructions: "x" }, OTHER)).rejects.toThrow("not created as bindable by this extension");
    await expect(call("chat:getBinding", { sessionId, extensionId: OTHER })).rejects.toThrow("not created as bindable");
    await expect(call("chat:unbind", { sessionId, extensionId: OTHER })).rejects.toThrow("not created as bindable");

    const plain = await create(EXT, false);
    await expect(bind(plain.sessionId, { instructions: "x" })).rejects.toThrow("not created as bindable");
    // A person's chat: created outside any extension.
    const person = await chatService.createSession("claude", { projectName: PROJECT, projectPath: PROJECT_PATH });
    await expect(bind(person.id, { instructions: "x" })).rejects.toThrow("not created as bindable");
    expect(getExtensionSessionBinding(person.id)).toBeNull();
  });

  it("is Claude only", async () => {
    await expect(create(EXT, true, "mock")).rejects.toThrow("Chỉ hỗ trợ Claude");
    const codex = await create(EXT, false, "mock");
    setSessionProvider(codex.sessionId, "codex");
    await expect(bind(codex.sessionId, { instructions: "x" })).rejects.toThrow("Chỉ hỗ trợ Claude");
    await expect(call("chat:createSession", { extensionId: EXT, projectName: PROJECT, providerId: "claude", bindable: "yes" })).rejects.toThrow("bindable must be a boolean");
  });

  it("validates what is bound and stores nothing on a refusal", async () => {
    const { sessionId } = await create();
    const refused = [
      [{ instructions: "x".repeat(64 * 1024 + 1) }, "exceed"],
      [{ instructions: 1 }, "instructions must be"],
      [{ toolsets: ["a", "b"] }, "toolsets entries"],
      [{ toolsets: ["fg", "fg"] }, "must not repeat"],
      [{ toolsets: Array.from({ length: 9 }, (_, i) => `t${i}`) }, "at most 8"],
      [{ toolsets: ["Fg"] }, "toolsets entries"],
      [{ toolPolicy: { readRoots: ["relative/dir"], writeRoots: [] } }, "absolute paths"],
      [{ toolPolicy: { readRoots: [], writeRoots: "/r" } }, "must be an array"],
      [{ toolPolicy: { readRoots: [], writeRoots: [], protectedPaths: ["/abs/**"] } }, "relative patterns"],
      [{ toolPolicy: { readRoots: [], writeRoots: [], allowTools: ["rm -rf"] } }, "tool names"],
      [null, "binding must be an object"],
    ] as const;
    for (const [binding, message] of refused) await expect(bind(sessionId, binding)).rejects.toThrow(message);
    expect(getExtensionSessionBinding(sessionId)).toMatchObject({ instructions: null, toolsets_json: "[]", tool_policy_json: null });
    expect(await bind(sessionId, { instructions: "é".repeat(32 * 1024) })).toMatchObject({ toolsets: [] });
    expect(await bind(sessionId, { toolPolicy: { readRoots: ["C:\\r"], writeRoots: [] } })).toMatchObject({ toolPolicy: { readRoots: ["C:\\r"] } });
  });
});

describe("lifetime", () => {
  it("deletes the binding with the session", async () => {
    const { sessionId } = await create();
    await bind(sessionId, { toolPolicy: POLICY });
    await chatService.deleteSession("claude", sessionId);
    expect(getExtensionSessionBinding(sessionId)).toBeNull();
  });

  it("closes the extension's bindings and deletes its toolsets with the extension, and nobody else's", async () => {
    const mine = await create();
    const theirs = await create(OTHER);
    getDb().query("INSERT INTO extension_mcp_toolsets (extension_id, toolset_id, tools_json, updated_at) VALUES (?, 'fg', '[]', 'now')").run(EXT);
    deleteExtension(EXT);
    // Kept as a record that the chat is closed, so it can never run as an ordinary chat.
    expect(getExtensionSessionBinding(mine.sessionId)?.extension_removed_at).toBeString();
    expect(getExtensionSessionBinding(theirs.sessionId)?.extension_removed_at).toBeNull();
    expect(getDb().query("SELECT COUNT(*) AS n FROM extension_mcp_toolsets WHERE extension_id = ?").get(EXT)).toEqual({ n: 0 });
  });

  it("moves the binding and the creator with a migrated session id", async () => {
    const { sessionId } = await create();
    await bind(sessionId, { instructions: "# Manager", toolPolicy: POLICY });
    const moved = `${sessionId}-moved`;
    setSessionMigratedTo(sessionId, moved);
    expect(getExtensionSessionBinding(sessionId)).toBeNull();
    expect(getExtensionSessionBinding(moved)).toMatchObject({ extension_id: EXT, instructions: "# Manager" });
    expect(getSessionCreatedByExtension(moved)).toBe(EXT);
    // Either id still finds it, for the turn and for the extension.
    expect(sessionBindingFor(sessionId)?.sessionId).toBe(moved);
    expect(await bind(sessionId, { instructions: "# Manager v2" })).toMatchObject({ sessionId: moved, instructions: "# Manager v2" });
    await chatService.deleteSession("claude", sessionId);
    expect(getExtensionSessionBinding(moved)).toBeNull();
  });

  it("keeps the destination's own binding when one already exists", async () => {
    const a = await create();
    const b = await create();
    await bind(a.sessionId, { instructions: "A" });
    await bind(b.sessionId, { instructions: "B" });
    setSessionMigratedTo(a.sessionId, b.sessionId);
    expect(getExtensionSessionBinding(a.sessionId)).toBeNull();
    expect(getExtensionSessionBinding(b.sessionId)).toMatchObject({ instructions: "B" });
  });

  it("refuses to read back a stored policy that no longer validates", () => {
    insertExtensionSessionBinding("corrupt-session", EXT);
    getDb().query("UPDATE extension_session_bindings SET tool_policy_json = '{\"readRoots\":\"/\"}' WHERE session_id = 'corrupt-session'").run();
    expect(() => sessionBindingFor("corrupt-session")).toThrow("must be an array");
  });
});
