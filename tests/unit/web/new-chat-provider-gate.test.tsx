import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import { act } from "react";

installDom();
afterAll(uninstallDom);
const { NewChatProviderGate, useNewChatPreparation } = await import("../../../src/web/components/chat/new-chat-provider-gate");
const { clearChatPreparationCache } = await import("../../../src/web/lib/chat-preparation-cache");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { api } = await import("../../../src/web/lib/api-client");
const { updateAISettings } = await import("../../../src/web/lib/api-settings");
const { startPrepare, __clearPrepareForTest } = await import("../../../src/web/lib/new-chat-prepare-client");
const { writeChatPreparationSettings, writeChatProviders } = await import("../../../src/web/lib/chat-preference-local-cache");
const { projectCacheId } = await import("../../../src/web/lib/browser-cache/cache-keys");
const settings = { default_provider: "codex", new_chat_provider_mode: "follow-focus",
  providers: { codex: { permission_mode: "plan" }, claude: { permission_mode: "acceptEdits" } } };
let view: Mounted | null = null;
let get: ReturnType<typeof spyOn>;
let preparation: ReturnType<typeof useNewChatPreparation>;

function Composer({ providerId }: { providerId: unknown }) {
  preparation = useNewChatPreparation();
  return <><span>Composer {String(providerId)}</span><input aria-label="Draft" /></>;
}

function Harness() {
  const metadata = usePanelStore((s) => s.panels.main!.tabs[0]!.metadata!);
  return <NewChatProviderGate tabId="new" metadata={metadata}><Composer providerId={metadata.providerId} /></NewChatProviderGate>;
}
beforeEach(() => {
  clearChatPreparationCache();
  __clearPrepareForTest();
  // This gate now consults the real local cache (`readChatPreparationSettings` /
  // `readChatProviders`) for a synchronous warm-restore path — clear it so no run's
  // write (this file's own `updateAISettings` test included) leaks into another.
  localStorage.clear();
  usePanelStore.setState({ currentProject: "project", focusedPanelId: "main", grid: [["main"]],
    lastFocusedChatProviders: {}, panels: { main: { id: "main", activeTabId: "new", tabHistory: ["new"],
      tabs: [{ id: "new", type: "chat", title: "Chat", projectId: "project", closable: true,
        metadata: { projectName: "project", providerPending: true, focusedProviderOnOpen: "codex" } }] } } });
  get = spyOn(api, "get");
});
afterEach(async () => { await view?.unmount(); view = null; get.mockRestore(); localStorage.clear(); });

it("resolves a remembered default placeholder before an immediate send", async () => {
  usePanelStore.getState().updateTab("new", { metadata: {
    projectName: "project", providerPending: true, focusedProviderOnOpen: "default",
  } });
  get.mockImplementation((path: string) => Promise.resolve(path === "/api/settings/ai"
    ? settings : [{ id: "codex", name: "Codex" }]));
  view = await mount(<Harness />);
  await act(async () => {
    expect((await preparation.prepare()).providerId).toBe("codex");
  });
  expect(view.container.textContent).not.toContain("default is not available");
});

it("keeps the composer mounted while preparing and applies the selected provider's permissions", async () => {
  let resolve!: (value: unknown) => void;
  get.mockImplementation((path: string) => path === "/api/settings/ai"
    ? new Promise((done) => { resolve = done; }) : Promise.resolve([{ id: "codex", name: "Codex" }]));
  view = await mount(<Harness />);
  expect(view.container.textContent).toContain("Preparing chat");
  expect(view.container.textContent).toContain("Composer");
  const input = view.container.querySelector("input")!;
  input.value = "draft typed during preparation";
  const first = preparation.prepare();
  expect(preparation.prepare()).toBe(first);
  await act(async () => { resolve(settings); });
  expect(await first).toEqual({ providerId: "codex", permissionMode: "plan" });
  expect(view.container.textContent).toBe("Composer codex");
  expect(view.container.querySelector("input")).toBe(input);
  expect(input.value).toBe("draft typed during preparation");
  expect(usePanelStore.getState().panels.main!.tabs[0]!.metadata!.permissionMode).toBe("plan");
});

it("offers the sole available provider when the selected provider is unavailable", async () => {
  get.mockImplementation((path: string) => Promise.resolve(path === "/api/settings/ai"
    ? settings : [{ id: "claude", name: "Claude" }]));
  view = await mount(<Harness />);
  expect(view.container.textContent).toContain("codex is not available");
  expect(view.container.textContent).toContain("Composer");
  expect(usePanelStore.getState().panels.main!.tabs[0]!.metadata!.providerId).toBeUndefined();
  await act(async () => {
    await expect(preparation.prepare()).rejects.toThrow("codex is not available");
  });
  await click(view.container.querySelector("button"));
  expect(view.container.textContent).toBe("Composer claude");
  expect(usePanelStore.getState().panels.main!.tabs[0]!.metadata!.permissionMode).toBe("acceptEdits");
});

it("lets the user retry a settings failure without falling back silently", async () => {
  let fail = true;
  get.mockImplementation((path: string) => path === "/api/settings/ai" && fail
    ? Promise.reject(new Error("offline")) : Promise.resolve(path === "/api/settings/ai"
      ? settings : [{ id: "codex", name: "Codex" }]));
  view = await mount(<Harness />);
  expect(view.container.textContent).toContain("Could not load chat settings");
  expect(view.container.textContent).toContain("Composer");
  expect(usePanelStore.getState().panels.main!.tabs[0]!.metadata!.providerId).toBeUndefined();
  fail = false;
  await click(view.container.querySelector("button"));
  expect(view.container.textContent).toBe("Composer codex");
});

it("returns the actual provider and permission mode after the user changes the resolved selection", async () => {
  get.mockImplementation((path: string) => Promise.resolve(path === "/api/settings/ai"
    ? settings : [{ id: "codex", name: "Codex" }, { id: "claude", name: "Claude" }]));
  view = await mount(<Harness />);
  await act(async () => {
    const store = usePanelStore.getState();
    const metadata = store.panels.main!.tabs[0]!.metadata!;
    store.updateTab("new", { metadata: { ...metadata, providerId: "claude", permissionMode: "acceptEdits" } });
  });
  expect(await preparation.prepare()).toEqual({ providerId: "claude", permissionMode: "acceptEdits" });
});

it("keeps the draft available when preparation times out and ignores a late response", async () => {
  let resolve!: (value: unknown) => void;
  get.mockImplementation((path: string) => path === "/api/settings/ai"
    ? new Promise((done) => { resolve = done; }) : Promise.resolve([{ id: "codex", name: "Codex" }]));
  const originalTimeout = globalThis.setTimeout;
  const timers: Array<() => void> = [];
  const timeout = spyOn(globalThis, "setTimeout");
  timeout.mockImplementation(((callback: () => void, ms: number, ...args: unknown[]) => {
    if (ms === 30_000) { timers.push(callback); return 0; }
    return originalTimeout(callback, ms, ...args);
  }) as typeof setTimeout);
  try {
    view = await mount(<Harness />);
    const input = view.container.querySelector("input");
    const request = preparation.prepare();
    await act(async () => {
      for (const expire of timers) expire();
      await expect(request).rejects.toThrow("timed out");
    });
    expect(view.container.textContent).toContain("Retry");
    expect(view.container.querySelector("input")).toBe(input);
    await act(async () => { resolve(settings); });
    expect(usePanelStore.getState().panels.main!.tabs[0]!.metadata!.providerId).toBeUndefined();
  } finally { timeout.mockRestore(); }
});

it("rejects settings invalidated by a save and retries with fresh provider permissions", async () => {
  let resolveOld!: (value: unknown) => void;
  const fresh = { default_provider: "claude", new_chat_provider_mode: "default",
    providers: { claude: { permission_mode: "acceptEdits" } } };
  get.mockImplementation((path: string) => path === "/api/settings/ai"
    ? new Promise((resolve) => { resolveOld = resolve; })
    : Promise.resolve([{ id: "codex", name: "Codex" }, { id: "claude", name: "Claude" }]));
  const put = spyOn(api, "put").mockResolvedValue(fresh);
  try {
    view = await mount(<Harness />);
    const input = view.container.querySelector("input");
    const old = preparation.prepare();
    await act(async () => {
      await updateAISettings({ default_provider: "claude", new_chat_provider_mode: "default" });
      resolveOld(settings);
      await expect(old).rejects.toThrow("Chat settings changed");
    });
    const metadata = usePanelStore.getState().panels.main!.tabs[0]!.metadata!;
    expect(metadata.providerPending).toBe(true);
    expect(metadata.providerId).toBeUndefined();
    expect(metadata.permissionMode).toBeUndefined();
    expect(view.container.querySelector("input")).toBe(input);
    get.mockImplementation((path: string) => Promise.resolve(path === "/api/settings/ai"
      ? fresh : [{ id: "claude", name: "Claude" }]));
    await click(view.container.querySelector("button"));
    expect(await preparation.prepare()).toEqual({ providerId: "claude", permissionMode: "acceptEdits" });
    expect(view.container.textContent).toBe("Composer claude");
  } finally { put.mockRestore(); }
});

it("joins the tab's own /chat/prepare instead of fetching settings and providers itself", async () => {
  const post = spyOn(api, "post").mockResolvedValue({
    resolvedProviderId: "claude", providerId: "claude",
    settings: { default_provider: "claude", providers: { claude: { permission_mode: "plan" } } },
    providers: [{ id: "claude", name: "Claude" }],
    pickedAccount: null, usage: null, draft: null, tags: null, slash: null,
  });
  try {
    // Simulates what ChatTab's own mount already did before this gate's effect runs.
    startPrepare("new", { name: "project", path: "project" }, { focusedProvider: "codex" });
    view = await mount(<Harness />);
    await act(async () => {
      expect(await preparation.prepare()).toEqual({ providerId: "claude", permissionMode: "plan" });
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  } finally { post.mockRestore(); }
});

it("resolves a tab restored mid-pending from the local cache before any fetch, with no request at all", async () => {
  const projectRef = { name: "project", path: "project" };
  writeChatPreparationSettings({ default_provider: "claude", providers: { claude: { permission_mode: "acceptEdits" } } });
  writeChatProviders(projectCacheId(projectRef), [{ id: "claude", name: "Claude" }]);
  usePanelStore.setState({ currentProject: "project", focusedPanelId: "main", grid: [["main"]],
    lastFocusedChatProviders: {}, panels: { main: { id: "main", activeTabId: "new", tabHistory: ["new"],
      tabs: [{ id: "new", type: "chat", title: "Chat", projectId: "project", closable: true,
        metadata: { projectName: "project", providerPending: true } }] } } });
  get.mockImplementation(() => new Promise(() => {})); // would hang forever if ever called
  view = await mount(<Harness />);
  expect(view.container.textContent).toBe("Composer claude");
  expect(get).not.toHaveBeenCalled();
});
