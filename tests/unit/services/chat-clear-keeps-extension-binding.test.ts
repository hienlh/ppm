/**
 * `/clear` in a chat an extension bound starts a new chat with an empty context. It clears the
 * context, not the binding: the new chat is the same extension's, with the same instructions and
 * tool limits, and a provider that cannot hold a binding is refused rather than handed an
 * unbound chat with every tool.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { createProjectChatSession } from "../../../src/services/chat-session-create.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import {
  getExtensionSessionBinding, getSessionCreatedByExtension, insertExtensionSessionBinding, openTestDb, setDb,
} from "../../../src/services/db.service.ts";
import { bindSession, getOwnedBinding } from "../../../src/services/extension-session-binding.service.ts";
import type { AIProvider } from "../../../src/types/chat.ts";

const POLICY = { readRoots: ["/r"], writeRoots: ["/r/.proposals"] };
const PROJECT = { projectName: "clear-bound", projectPath: "/tmp/clear-bound" };

function stubProvider(id: string, supportsExtensionBinding: boolean): AIProvider & { sessions: Map<string, unknown> } {
  // `sessions` is where `chatService.getSession` looks a live session up, project path included.
  const sessions = new Map<string, unknown>();
  return {
    id, name: id, supportsExtensionBinding, sessions,
    async createSession(config?: { projectPath?: string }) {
      const session = { id: crypto.randomUUID(), providerId: id, title: "", createdAt: "", ...(config?.projectPath ? { projectPath: config.projectPath } : {}) };
      sessions.set(session.id, session);
      return session;
    },
    async resumeSession(sessionId: string) { return { id: sessionId, providerId: id, title: "", createdAt: "" }; },
    async listSessions() { return []; },
    async deleteSession() {},
    async *sendMessage(sessionId: string) { yield { type: "done" as const, sessionId }; },
  };
}

const BINDING = stubProvider("stub-clear-binding", true);
const PLAIN = stubProvider("stub-clear-plain", false);

beforeAll(() => {
  providerRegistry.register(BINDING);
  providerRegistry.register(PLAIN);
  setDb(openTestDb());
});

async function boundChat(extensionId: string): Promise<string> {
  const session = await createProjectChatSession({ ...PROJECT, providerId: BINDING.id, adoptWarmSpare: false });
  insertExtensionSessionBinding(session.id, extensionId);
  bindSession(session.id, extensionId, { instructions: "# Manager", toolPolicy: POLICY });
  return session.id;
}

describe("/clear in a chat an extension bound", () => {
  it("starts a chat that is still the extension's, with its instructions and tool limits", async () => {
    const source = await boundChat("clear-ext");
    const cleared = await createProjectChatSession({ ...PROJECT, providerId: BINDING.id, adoptWarmSpare: true, clearedFrom: source });

    expect(cleared.id).not.toBe(source);
    expect(getExtensionSessionBinding(cleared.id)).toMatchObject({ extension_id: "clear-ext", tool_policy_json: JSON.stringify(POLICY) });
    expect(getSessionCreatedByExtension(cleared.id)).toBe("clear-ext");
    // The extension can still drive it, and a turn runs under the policy.
    expect(() => getOwnedBinding(cleared.id, "clear-ext")).not.toThrow();
    const turn = await chatService.prepareSendOptions(BINDING.id, cleared.id, "hi", { permissionMode: "bypassPermissions" });
    expect(turn.extensionToolPolicy).toEqual(POLICY);
    expect(turn.extensionInstructions).toBe("# Manager");
    expect(turn.permissionMode).toBe("acceptEdits");
  });

  it("is refused on a provider that cannot hold a binding, rather than give an unbound chat", async () => {
    const source = await boundChat("clear-ext-2");
    await expect(createProjectChatSession({ ...PROJECT, providerId: PLAIN.id, adoptWarmSpare: false, clearedFrom: source }))
      .rejects.toThrow("managed by an extension");
  });

  it("binds nothing from a chat of another project, nor into a design chat", async () => {
    const source = await boundChat("clear-ext-3");
    const elsewhere = await createProjectChatSession({
      projectName: "other-project", projectPath: "/tmp/other-project", providerId: BINDING.id, adoptWarmSpare: false, clearedFrom: source,
    });
    expect(getExtensionSessionBinding(elsewhere.id)).toBeNull();
    expect(getSessionCreatedByExtension(elsewhere.id)).toBeNull();
    const design = await createProjectChatSession({ ...PROJECT, providerId: BINDING.id, adoptWarmSpare: false, clearedFrom: source, designSlug: "landing" });
    expect(getExtensionSessionBinding(design.id)).toBeNull();
  });

  it("treats the same project spelled another way as the same project", async () => {
    const source = await boundChat("clear-ext-4");
    const cleared = await createProjectChatSession({
      ...PROJECT, projectPath: `${PROJECT.projectPath}/sub/..`, providerId: BINDING.id, adoptWarmSpare: false, clearedFrom: source,
    });
    expect(getExtensionSessionBinding(cleared.id)).toMatchObject({ extension_id: "clear-ext-4" });
  });

  it("leaves an ordinary chat's /clear an ordinary chat", async () => {
    const source = await createProjectChatSession({ ...PROJECT, providerId: BINDING.id, adoptWarmSpare: false });
    const cleared = await createProjectChatSession({ ...PROJECT, providerId: BINDING.id, adoptWarmSpare: false, clearedFrom: source.id });
    expect(getExtensionSessionBinding(cleared.id)).toBeNull();
  });
});
