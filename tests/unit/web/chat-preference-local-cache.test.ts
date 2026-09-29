/**
 * The localStorage cache for chat-preparation settings and a project's
 * provider list. Both must shape-validate on read — anything pulled back out
 * of localStorage may be stale, hand-edited, or written by an older build —
 * and neither may ever hold account ids, labels or other secrets, even if a
 * caller hands the writer a full settings object that has them.
 */
import { describe, it, expect, beforeEach } from "bun:test";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  get length() { return store.size; },
  key: (i: number) => [...store.keys()][i] ?? null,
};

const {
  readChatPreparationSettings,
  writeChatPreparationSettings,
  readChatProviders,
  writeChatProviders,
  CHAT_PREF_STORAGE_KEY,
} = await import("../../../src/web/lib/chat-preference-local-cache");
const { providers: providersKey } = await import("../../../src/web/lib/browser-cache/cache-keys");
const { wipeBrowserCaches } = await import("../../../src/web/lib/browser-cache/wipe-browser-caches");

beforeEach(() => store.clear());

describe("chat-preference-local-cache — settings", () => {
  it("round-trips the settings subset", () => {
    writeChatPreparationSettings({
      default_provider: "claude",
      new_chat_provider_mode: "follow-focus",
      providers: { claude: { permission_mode: "acceptEdits" } },
    });
    expect(readChatPreparationSettings()).toEqual({
      default_provider: "claude",
      new_chat_provider_mode: "follow-focus",
      providers: { claude: { permission_mode: "acceptEdits" } },
    });
  });

  it("strips fields outside the cached subset, even from a full settings object", () => {
    writeChatPreparationSettings({
      default_provider: "claude",
      // Fields a full AISettings carries that must never be cached:
      providers: {
        claude: {
          permission_mode: "plan",
          api_key: "sk-should-not-be-cached",
          base_url: "https://example.test",
        } as any,
      },
      share_provider_context: true,
    } as any);

    const stored = JSON.parse(store.get(CHAT_PREF_STORAGE_KEY)!);
    expect(stored).toEqual({
      default_provider: "claude",
      providers: { claude: { permission_mode: "plan" } },
    });
    expect(stored.share_provider_context).toBeUndefined();
    expect(stored.providers.claude.api_key).toBeUndefined();
    expect(stored.providers.claude.base_url).toBeUndefined();
  });

  it("returns null for missing, corrupt or shape-invalid data", () => {
    expect(readChatPreparationSettings()).toBeNull();

    store.set(CHAT_PREF_STORAGE_KEY, "{not json");
    expect(readChatPreparationSettings()).toBeNull();

    store.set(CHAT_PREF_STORAGE_KEY, JSON.stringify({ new_chat_provider_mode: "follow-focus" }));
    expect(readChatPreparationSettings()).toBeNull(); // missing default_provider

    store.set(CHAT_PREF_STORAGE_KEY, JSON.stringify({ default_provider: "claude", new_chat_provider_mode: "bogus" }));
    expect(readChatPreparationSettings()).toBeNull(); // invalid enum value
  });

  it("is cleared by wipeBrowserCaches", async () => {
    writeChatPreparationSettings({ default_provider: "claude", providers: {} });
    expect(readChatPreparationSettings()).not.toBeNull();
    await wipeBrowserCaches();
    expect(readChatPreparationSettings()).toBeNull();
  });
});

describe("chat-preference-local-cache — per-project providers", () => {
  it("round-trips a project's provider list, scoped by projectId", () => {
    writeChatProviders("proj-a", [{ id: "claude", name: "Claude" }]);
    writeChatProviders("proj-b", [{ id: "codex", name: "Codex" }]);

    expect(readChatProviders("proj-a")).toEqual([{ id: "claude", name: "Claude" }]);
    expect(readChatProviders("proj-b")).toEqual([{ id: "codex", name: "Codex" }]);
  });

  it("drops entries missing id or name and returns null for a non-array", () => {
    writeChatProviders("proj-c", [
      { id: "claude", name: "Claude" },
      { id: "broken" } as any,
    ]);
    expect(readChatProviders("proj-c")).toEqual([{ id: "claude", name: "Claude" }]);

    store.set(providersKey("proj-d"), JSON.stringify({ not: "an array" }));
    expect(readChatProviders("proj-d")).toBeNull();
  });

  it("returns null when nothing was ever cached for a project", () => {
    expect(readChatProviders("never-cached")).toBeNull();
  });

  it("is cleared by wipeBrowserCaches for every project at once", async () => {
    writeChatProviders("proj-a", [{ id: "claude", name: "Claude" }]);
    writeChatProviders("proj-b", [{ id: "codex", name: "Codex" }]);
    await wipeBrowserCaches();
    expect(readChatProviders("proj-a")).toBeNull();
    expect(readChatProviders("proj-b")).toBeNull();
  });
});
