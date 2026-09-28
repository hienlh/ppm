import { beforeEach, describe, expect, it } from "bun:test";
import { usePanelStore } from "../../../src/web/stores/panel-store";
import { resolveNewChatProvider } from "../../../src/web/lib/new-chat-provider";
import type { AISettings } from "../../../src/web/lib/api-settings";
import type { Panel } from "../../../src/web/stores/panel-utils";

const values = new Map<string, string>();
Object.assign(globalThis, { localStorage: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
} });

const settings: AISettings = { default_provider: "codex", new_chat_provider_mode: "follow-focus", providers: {} };
function panel(id: string, provider: string, projectId = "project-a"): Panel {
  return { id, tabs: [{ id: `${id}-chat`, type: "chat", title: "Chat", projectId,
    closable: true, metadata: { providerId: provider, projectName: projectId } }],
  activeTabId: `${id}-chat`, tabHistory: [`${id}-chat`] };
}
function newChat(panelId = "right", projectId = "project-a") {
  return usePanelStore.getState().openTab({ type: "chat", title: "AI Chat", projectId,
    closable: true, metadata: { projectName: projectId } }, panelId);
}
function metadata(id: string) {
  return usePanelStore.getState().getPanelForTab(id)!.tabs.find((t) => t.id === id)!.metadata!;
}
beforeEach(() => {
  values.clear();
  usePanelStore.setState({ panels: {}, currentProject: null, focusedPanelId: "", lastFocusedChatProviders: {} });
  usePanelStore.setState({ panels: { left: panel("left", "codex"), right: panel("right", "claude") },
    grid: [["left", "right"]], focusedPanelId: "left", currentProject: "project-a",
    projectGrids: {}, projectFocused: {}, projectDock: {}, dock: { visible: false, height: 30 } });
});

describe("new chat provider", () => {
  it("captures focus across panels and is not changed by subsequent focus", () => {
    const id = newChat();
    expect(metadata(id).providerPending).toBe(true);
    expect(metadata(id).focusedProviderOnOpen).toBe("codex");
    usePanelStore.getState().setActiveTab("right-chat", "right");
    expect(metadata(id).focusedProviderOnOpen).toBe("codex");
    expect(resolveNewChatProvider(settings, metadata(id).focusedProviderOnOpen as string)).toBe("codex");
    const second = newChat("left");
    expect(metadata(second).focusedProviderOnOpen).toBe("claude");
  });

  it("tracks panel-body focus even when its active tab does not change", () => {
    usePanelStore.getState().setFocusedPanel("right");
    expect(metadata(newChat("left")).focusedProviderOnOpen).toBe("claude");
  });

  it("opening the other panel's plus menu changes destination without focusing its chat", () => {
    usePanelStore.getState().setFocusedPanel("right", false);
    expect(metadata(newChat()).focusedProviderOnOpen).toBe("codex");
  });

  it("retains the last chat through editor and terminal activation", () => {
    for (const type of ["editor", "terminal"] as const) {
      usePanelStore.getState().openTab({ type, title: type, projectId: "project-a", closable: true });
    }
    expect(metadata(newChat()).focusedProviderOnOpen).toBe("codex");
  });

  it("isolates projects and falls back when the project has no focused chat", () => {
    const id = newChat("right", "project-b");
    expect(metadata(id).focusedProviderOnOpen).toBeUndefined();
    expect(resolveNewChatProvider(settings)).toBe("codex");
  });

  it("tracks provider changes only in the focused chat", () => {
    usePanelStore.getState().updateTab("right-chat", { metadata: { providerId: "gemini" } });
    expect(usePanelStore.getState().lastFocusedChatProviders["project-a"]).toBe("codex");
    usePanelStore.getState().updateTab("left-chat", { metadata: { providerId: "cursor" } });
    expect(metadata(newChat()).focusedProviderOnOpen).toBe("cursor");
  });

  it("default mode ignores focus and legacy settings behave as default mode", () => {
    expect(resolveNewChatProvider({ ...settings, new_chat_provider_mode: "default" }, "claude")).toBe("codex");
    expect(resolveNewChatProvider({ ...settings, new_chat_provider_mode: undefined }, "claude")).toBe("codex");
  });

  it("keeps explicit providers for history, forks and clear", () => {
    for (const extra of [{ sessionId: "existing" }, { clearedFrom: "old" }, {}]) {
      const id = usePanelStore.getState().openTab({ type: "chat", title: "Chat", projectId: "project-a",
        closable: true, metadata: { providerId: "claude", ...extra } });
      expect(metadata(id).providerId).toBe("claude");
      expect(metadata(id).providerPending).toBeUndefined();
    }
  });

  it("does not apply defaults to an existing session without provider metadata", () => {
    const id = usePanelStore.getState().openTab({ type: "chat", title: "History", projectId: "project-a",
      closable: true, metadata: { sessionId: "legacy" } });
    expect(metadata(id).providerPending).toBeUndefined();
  });

  it("provider resolution in a background tab does not steal focus memory", () => {
    const id = newChat();
    usePanelStore.getState().setActiveTab("left-chat", "left");
    usePanelStore.getState().updateTab(id, { metadata: { providerId: "claude" } });
    expect(usePanelStore.getState().lastFocusedChatProviders["project-a"]).toBe("codex");
  });
});
