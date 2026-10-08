/**
 * On a desktop a design opens in a floating window of its own: the window is the design's
 * home, so closing it closes the design rather than handing a tab back to the grid. A design
 * the user already keeps in the grid stays there, and the setting turns the whole thing off.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");
const { useWindowStore } = await import("../../../src/web/components/floating-window/window-store");
const { closeWindow } = await import("../../../src/web/components/floating-window/close-window");
const { isWindowPanelId, windowIdFromPanelId } = await import("../../../src/web/stores/panel-utils");
const { openDesignTab } = await import("../../../src/web/lib/design/open-design-tab");

const editorTab = { id: "editor:a.ts", type: "editor" as const, title: "a.ts", projectId: "p", closable: true, metadata: { filePath: "a.ts" } };

beforeEach(() => {
  useWindowStore.setState({ windows: {}, bounds: { w: 1400, h: 860 }, restored: true, snapPreviewId: null });
  useSettingsStore.setState({ designWindows: true });
  usePanelStore.setState({
    currentProject: "p", focusedPanelId: "left", grid: [["left"]], lastFocusedChatProviders: {},
    panels: { left: { id: "left", activeTabId: editorTab.id, tabHistory: [editorTab.id], tabs: [editorTab] } },
  } as never);
});

const panelOf = (tabId: string) => usePanelStore.getState().getPanelForTab(tabId)!.id;
const windowOf = (tabId: string) => windowIdFromPanelId(panelOf(tabId))!;

describe("opening a design on a desktop", () => {
  it("puts a design that was not open into a window that is its home", () => {
    const id = openDesignTab({ projectName: "p", slug: "landing" });
    expect(isWindowPanelId(panelOf(id))).toBe(true);
    const win = useWindowStore.getState().windows[windowOf(id)]!;
    expect(win.kind).toBe("tab-host");
    expect(win.payload?.closeTabsOnClose).toBe(true);
    // Focus stays on the grid, so the next tab opened does not land in the window.
    expect(isWindowPanelId(usePanelStore.getState().focusedPanelId)).toBe(false);
  });

  it("closes the design with its window instead of docking it back into the grid", () => {
    const id = openDesignTab({ projectName: "p", slug: "landing" });
    const windowId = windowOf(id);
    closeWindow(windowId);
    expect(usePanelStore.getState().getPanelForTab(id)).toBeUndefined();
    expect(useWindowStore.getState().windows[windowId]).toBeUndefined();
  });

  it("brings a minimized design window back instead of opening a second one", () => {
    const id = openDesignTab({ projectName: "p", slug: "landing" });
    const windowId = windowOf(id);
    useWindowStore.getState().setState(windowId, "minimized");
    expect(openDesignTab({ projectName: "p", slug: "landing" })).toBe(id);
    expect(Object.keys(useWindowStore.getState().windows)).toEqual([windowId]);
    expect(useWindowStore.getState().windows[windowId]!.state).toBe("normal");
  });

  it("brings the window forward when its session is opened as a chat (a notification, a link)", () => {
    const id = openDesignTab({ projectName: "p", slug: "landing", sessionId: "sess-9" });
    const windowId = windowOf(id);
    useWindowStore.getState().setState(windowId, "minimized");
    const opened = usePanelStore.getState().openTab({
      type: "chat", title: "Chat", projectId: "p", closable: true, metadata: { projectName: "p", sessionId: "sess-9" },
    });
    expect(opened).toBe(id);
    expect(useWindowStore.getState().windows[windowId]!.state).toBe("normal");
  });

  it("keeps a design that takes a chat's place in that chat's panel", () => {
    const id = openDesignTab({ projectName: "p", slug: "landing", panelId: "left", inPlace: true });
    expect(panelOf(id)).toBe("left");
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(0);
  });

  it("leaves a design the user keeps in the grid where it is", () => {
    useSettingsStore.setState({ designWindows: false });
    const id = openDesignTab({ projectName: "p", slug: "landing" });
    expect(panelOf(id)).toBe("left");
    useSettingsStore.setState({ designWindows: true });
    openDesignTab({ projectName: "p", slug: "landing" });
    expect(panelOf(id)).toBe("left");
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(0);
  });
});
