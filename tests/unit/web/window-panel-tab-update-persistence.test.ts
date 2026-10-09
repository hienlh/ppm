/**
 * A tab inside a floating window lives in an off-grid panel that no project layout holds, so it
 * is saved under its own key. What the tab learns after it was popped out — the session a new
 * chat or the PPM Assistant creates with its first message — must be saved there too, or a
 * reload brings the window back on the tab as it was when it opened (an empty draft).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { loadWindowPanels } = await import("../../../src/web/stores/window-panel-persistence");
const { patchTabMetadata } = await import("../../../src/web/lib/patch-tab-metadata");

const WINDOW_PANEL = "__win__:win-1";
const assistantTab = {
  id: "assistant", type: "assistant" as const, title: "PPM Assistant", projectId: null, closable: true,
  metadata: { projectName: "__assistant__" },
};
const editorTab = { id: "editor:a.ts", type: "editor" as const, title: "a.ts", projectId: "p", closable: true, metadata: { filePath: "a.ts" } };

beforeEach(() => {
  localStorage.clear();
  usePanelStore.setState({
    currentProject: "p", focusedPanelId: "main", grid: [["main"]],
    panels: {
      main: { id: "main", activeTabId: editorTab.id, tabHistory: [editorTab.id], tabs: [editorTab] },
      [WINDOW_PANEL]: { id: WINDOW_PANEL, activeTabId: "assistant", tabHistory: ["assistant"], tabs: [assistantTab] },
    },
  } as never);
});

describe("updating a tab in a floating window", () => {
  it("saves the tab's new metadata with the window panels, where a reload reads it", () => {
    patchTabMetadata("assistant", { sessionId: "sess-1", providerId: "claude" });
    const restored = loadWindowPanels()[WINDOW_PANEL]?.tabs.find((t) => t.id === "assistant");
    expect(restored?.metadata).toMatchObject({ projectName: "__assistant__", sessionId: "sess-1", providerId: "claude" });
  });

  it("keeps the latest update when a tab changes again", () => {
    patchTabMetadata("assistant", { sessionId: "sess-1" });
    patchTabMetadata("assistant", { sessionId: "sess-2", assistantChatEpoch: 2 });
    const restored = loadWindowPanels()[WINDOW_PANEL]?.tabs.find((t) => t.id === "assistant");
    expect(restored?.metadata).toMatchObject({ sessionId: "sess-2", assistantChatEpoch: 2 });
  });

  it("leaves the window panels alone when a grid tab changes", () => {
    patchTabMetadata("editor:a.ts", { lineNumber: 4 });
    expect(localStorage.getItem("ppm-window-panels")).toBeNull();
  });
});
