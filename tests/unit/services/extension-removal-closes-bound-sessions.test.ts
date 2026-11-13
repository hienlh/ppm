/**
 * The chats an extension bound outlive the extension — in the history, in an open tab — and
 * must not turn into ordinary chats with every tool when it goes. When the user removes it, its
 * bound chats stay closed: every turn is refused, and a fork of one is closed too. When the startup
 * sweep only finds its folder missing, they stay bound and open, tool limits included.
 */
import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import "../../test-setup.ts";
import { chatService } from "../../../src/services/chat.service.ts";
import { extensionService } from "../../../src/services/extension.service.ts";
import { providerRegistry } from "../../../src/providers/registry.ts";
import {
  deleteExtension, getExtensionById, getExtensionSessionBinding, insertExtension, insertExtensionSessionBinding,
  openTestDb, setDb,
} from "../../../src/services/db.service.ts";
import { bindSession, copyBindingToFork, getOwnedBinding } from "../../../src/services/extension-session-binding.service.ts";
import type { AIProvider } from "../../../src/types/chat.ts";

const PROVIDER = "stub-closed-bind";
const POLICY = { readRoots: ["/r"], writeRoots: ["/r/.proposals"] };

const provider: AIProvider = {
  id: PROVIDER, name: PROVIDER, supportsExtensionBinding: true,
  async createSession() { return { id: "x", providerId: PROVIDER, title: "", createdAt: "" }; },
  async resumeSession() { return { id: "x", providerId: PROVIDER, title: "", createdAt: "" }; },
  async listSessions() { return []; },
  async deleteSession() {},
  async *sendMessage(sessionId: string) { yield { type: "done" as const, sessionId }; },
};

beforeAll(() => {
  providerRegistry.register(provider);
  // The startup sweep removes every record it does not find on disk, so it gets a database
  // of this file's own. `setDb` closes the one before, so it is not handed back afterwards.
  setDb(openTestDb());
});

function boundSession(sessionId: string, extensionId: string, binding: Record<string, unknown> = { instructions: "# Manager", toolPolicy: POLICY }) {
  insertExtensionSessionBinding(sessionId, extensionId);
  bindSession(sessionId, extensionId, binding);
}

const turn = (sessionId: string) => chatService.prepareSendOptions(PROVIDER, sessionId, "hi", { permissionMode: "bypassPermissions" });

describe("removing an extension", () => {
  it("closes its bound chats instead of unbinding them, and leaves other extensions' chats alone", async () => {
    boundSession("removed-a", "gone-ext");
    boundSession("removed-b", "gone-ext", { instructions: "only instructions" });
    boundSession("kept", "staying-ext");
    deleteExtension("gone-ext");

    expect(getExtensionSessionBinding("removed-a")).toMatchObject({ extension_id: "gone-ext", tool_policy_json: JSON.stringify(POLICY) });
    await expect(turn("removed-a")).rejects.toThrow("The extension that managed this chat (gone-ext) was removed");
    await expect(turn("removed-b")).rejects.toThrow("was removed");
    // Nobody owns it any more, not even an extension that comes back under the same id.
    expect(() => getOwnedBinding("removed-a", "gone-ext")).toThrow("not created as bindable");

    expect((await turn("kept")).extensionToolPolicy).toEqual(POLICY);
  });

  it("keeps a fork of a closed chat closed", async () => {
    boundSession("closed-source", "gone-ext-2");
    deleteExtension("gone-ext-2");
    copyBindingToFork("closed-source", "closed-fork");
    await expect(turn("closed-fork")).rejects.toThrow("was removed");
  });

  it("keeps them bound and open when the startup sweep drops a record whose folder is gone", async () => {
    insertExtension({ id: "unmounted-ext", version: "1.0.0", display_name: null, description: null, icon: null, enabled: 1, manifest: "{}" });
    boundSession("swept", "unmounted-ext");
    expect((await turn("swept")).permissionMode).toBe("acceptEdits");

    const discover = spyOn(extensionService, "discover").mockResolvedValue([]);
    const activate = spyOn(extensionService, "activate").mockResolvedValue();
    try {
      await extensionService.startup();
      expect(activate).not.toHaveBeenCalled();
    } finally {
      discover.mockRestore();
      activate.mockRestore();
    }
    expect(getExtensionById("unmounted-ext")).toBeNull();
    // Still the extension's chat, policy and all: no every-tool ordinary chat, and not closed.
    const opts = await turn("swept");
    expect(opts.permissionMode).toBe("acceptEdits");
    expect(opts.extensionToolPolicy).toEqual(POLICY);
    expect(getExtensionSessionBinding("swept")).toMatchObject({ extension_id: "unmounted-ext", extension_removed_at: null });
  });
});
