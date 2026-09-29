/**
 * `panel-store.openTab`'s warm resolution for a sessionless chat tab: with a matching
 * local cache the tab is born resolved (no `providerPending`); anything less than a
 * full match keeps today's pending placeholder for `ChatTab`/`NewChatProviderGate` to
 * resolve over the network.
 *
 * `localStorage` is an in-memory stub installed through `installGlobal`, so this file's
 * writes stay out of the web storage every other file in the process shares, and the
 * real one comes back afterwards. `window` is the process-wide DOM's own: a bare
 * `EventTarget` in its place is what modules first imported here would bind their
 * listeners to for the rest of the run.
 */
import { afterAll, beforeEach, expect, it } from "bun:test";
import { installGlobal, uninstallDom } from "../../helpers/react-dom.tsx";

const store = new Map<string, string>();
afterAll(uninstallDom);
installGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  get length() { return store.size; },
  key: (i: number) => [...store.keys()][i] ?? null,
});

const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { writeChatPreparationSettings, writeChatProviders } = await import("../../../src/web/lib/chat-preference-local-cache");
const { projectCacheId } = await import("../../../src/web/lib/browser-cache/cache-keys");

const project = { name: "resolve-proj", path: "/resolve-proj" };

beforeEach(() => {
  store.clear();
  useProjectStore.setState({ projects: [project] });
  usePanelStore.setState({
    currentProject: project.name, focusedPanelId: "main", grid: [["main"]], lastFocusedChatProviders: {},
    panels: { main: { id: "main", activeTabId: null, tabHistory: [], tabs: [] } },
  } as never);
});

function openChat(metadata: Record<string, unknown> = {}) {
  const id = usePanelStore.getState().openTab({
    type: "chat", title: "AI Chat", projectId: project.name, closable: true,
    metadata: { projectName: project.name, ...metadata },
  });
  return usePanelStore.getState().panels.main!.tabs.find((t) => t.id === id)!.metadata!;
}

it("resolves warm — provider and permission set, no providerPending — when settings and the provider list both match", () => {
  writeChatPreparationSettings({ default_provider: "claude", providers: { claude: { permission_mode: "acceptEdits" } } });
  writeChatProviders(projectCacheId(project), [{ id: "claude", name: "Claude" }]);
  const metadata = openChat();
  expect(metadata).toMatchObject({ providerId: "claude", permissionMode: "acceptEdits" });
  expect(metadata.providerPending).toBeUndefined();
});

it("falls back to bypassPermissions when the cached settings name no permission for the provider", () => {
  writeChatPreparationSettings({ default_provider: "claude", providers: {} });
  writeChatProviders(projectCacheId(project), [{ id: "claude", name: "Claude" }]);
  expect(openChat().permissionMode).toBe("bypassPermissions");
});

it("stays cold — providerPending, focusedProviderOnOpen carried — with no cached settings at all", () => {
  const metadata = openChat();
  expect(metadata.providerPending).toBe(true);
  expect(metadata.providerId).toBeUndefined();
});

it("stays cold when settings are cached but the provider list is not", () => {
  writeChatPreparationSettings({ default_provider: "claude", providers: {} });
  expect(openChat().providerPending).toBe(true);
});

it("stays cold when the resolved provider is not in the cached provider list", () => {
  writeChatPreparationSettings({ default_provider: "codex", providers: {} });
  writeChatProviders(projectCacheId(project), [{ id: "claude", name: "Claude" }]);
  const metadata = openChat();
  expect(metadata.providerPending).toBe(true);
  expect(metadata.focusedProviderOnOpen).toBeUndefined();
});

it("honours follow-focus over the default when the project last focused another provider", () => {
  writeChatPreparationSettings({ default_provider: "claude", new_chat_provider_mode: "follow-focus",
    providers: { codex: { permission_mode: "plan" } } });
  writeChatProviders(projectCacheId(project), [{ id: "claude", name: "Claude" }, { id: "codex", name: "Codex" }]);
  usePanelStore.setState({ lastFocusedChatProviders: { [project.name]: "codex" } });
  expect(openChat()).toMatchObject({ providerId: "codex", permissionMode: "plan" });
});

it("does not touch a tab opened with an explicit providerId or sessionId", () => {
  const explicit = openChat({ providerId: "codex" });
  expect(explicit.providerPending).toBeUndefined();
  expect(explicit.permissionMode).toBeUndefined();

  const restored = openChat({ sessionId: "existing-session", providerId: "claude" });
  expect(restored.providerPending).toBeUndefined();
});

it("marks a warm-resolved permission as a cached default", () => {
  writeChatPreparationSettings({ default_provider: "claude", providers: { claude: { permission_mode: "acceptEdits" } } });
  writeChatProviders(projectCacheId(project), [{ id: "claude", name: "Claude" }]);
  expect(openChat().permissionModeSource).toBe("cache");
});

it("fills a /clear tab's permission from the cache, so its chip is never blank", () => {
  writeChatPreparationSettings({ default_provider: "claude", providers: { codex: { permission_mode: "plan" } } });
  // `/clear` hands over the old tab's mode as a placeholder; the cached default wins.
  expect(openChat({ providerId: "codex", permissionMode: "default", permissionModeSource: "cache" }))
    .toMatchObject({ providerId: "codex", permissionMode: "plan", permissionModeSource: "cache" });
  expect(openChat({ providerId: "codex" })).toMatchObject({ permissionMode: "plan", permissionModeSource: "cache" });
});

it("keeps the handed-over placeholder when the cache has nothing for that provider", () => {
  expect(openChat({ providerId: "codex", permissionMode: "default", permissionModeSource: "cache" }))
    .toMatchObject({ permissionMode: "default", permissionModeSource: "cache" });
});

it("never overrides a mode the caller decided", () => {
  writeChatPreparationSettings({ default_provider: "claude", providers: { codex: { permission_mode: "plan" } } });
  expect(openChat({ providerId: "codex", permissionMode: "default", permissionModeSource: "user" }).permissionMode).toBe("default");
});
