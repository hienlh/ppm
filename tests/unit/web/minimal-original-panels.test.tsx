import { afterAll, afterEach, expect, test } from "bun:test";
import { installDom, installGlobal, uninstallDom, mount, click } from "../../helpers/react-dom";
installDom();
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);
const React = await import("react");
const { EditorPanel } = await import("../../../src/web/components/layout/editor-panel");
const { TooltipProvider } = await import("../../../src/web/components/ui/tooltip");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");
const { visibleTabs } = await import("../../../src/web/stores/panel-utils");
afterEach(() => useSettingsStore.setState({ minimalMode: false }));

test("original panel keeps editor, chat and split layout, and opens chat with the existing plus", async () => {
  useSettingsStore.setState({ minimalMode: true });
  useProjectStore.setState({ projects: [], activeProject: null });
  const editor = { id: "editor:a", type: "editor" as const, title: "hidden-editor", projectId: "p", closable: true, metadata: { unsavedContent: "keep me" } };
  const chat = { id: "chat:1", type: "chat" as const, title: "existing-chat", projectId: "p", closable: true };
  usePanelStore.setState({ currentProject: "p", focusedPanelId: "right", grid: [["left", "right"]],
    panels: {
      left: { id: "left", tabs: [editor, chat], activeTabId: editor.id, tabHistory: [editor.id] },
      right: { id: "right", tabs: [], activeTabId: null, tabHistory: [] },
    },
  });
  const rendered = await mount(<TooltipProvider><EditorPanel panelId="left" projectName="p" /></TooltipProvider>);
  try {
    expect(rendered.container.textContent).toContain("existing-chat");
    expect(rendered.container.textContent).toContain("hidden-editor");
    expect(usePanelStore.getState().panels.left!.activeTabId).toBe(editor.id);
    expect(usePanelStore.getState().focusedPanelId).toBe("right");
    expect(usePanelStore.getState().grid).toEqual([["left", "right"]]);
    expect(usePanelStore.getState().panels.left!.tabs[0]).toEqual(editor);
    expect(visibleTabs([editor, chat], "p")).toEqual([editor, chat]);
    await click(rendered.container.querySelector('[title="New chat"]'));
    expect(usePanelStore.getState().panels.left!.tabs.filter((t) => t.type === "chat")).toHaveLength(2);
    expect(usePanelStore.getState().panels.left!.tabs[0]).toEqual(editor);
  } finally { await rendered.unmount(); }
});

test("minimal keeps the settings tab visible and active alongside chat", async () => {
  useSettingsStore.setState({ minimalMode: true });
  useProjectStore.setState({ projects: [], activeProject: null });
  const chat = { id: "chat:1", type: "chat" as const, title: "Chat", projectId: "p", closable: true };
  usePanelStore.setState({ currentProject: "p", focusedPanelId: "left", grid: [["left"]],
    panels: { left: { id: "left", tabs: [chat], activeTabId: chat.id, tabHistory: [] } },
  });
  const settingsId = usePanelStore.getState().openTab({ type: "settings", title: "Settings", projectId: null, closable: true });
  expect(settingsId).not.toBe("");
  const rendered = await mount(<TooltipProvider><EditorPanel panelId="left" projectName="p" /></TooltipProvider>);
  try {
    expect(rendered.container.textContent).toContain("Settings");
    expect(usePanelStore.getState().panels.left!.activeTabId).toBe(settingsId);
    expect(visibleTabs(usePanelStore.getState().panels.left!.tabs, "p", true)).toHaveLength(2);
  } finally { await rendered.unmount(); }
});
