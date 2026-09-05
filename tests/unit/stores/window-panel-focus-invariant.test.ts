/**
 * `focusedPanelId` must never name a `__win__:` panel.
 *
 * Focus decides where the next `openTab()` with no explicit panel lands. A floating
 * window renders no tab bar, so a tab opened inside one is unreachable until the window
 * is closed — and the id is persisted with the layout, so it survives a reload.
 *
 * The writers exercised here all pick a panel by scanning the WHOLE `panels` map, which
 * includes the off-grid window panels: the chat-session dedupe, the singleton dedupe,
 * `setActiveTab` with no panel id, and the last-tab-close focus fallback.
 */
import { describe, it, expect, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Minimal in-memory localStorage stub — must be set before store import
// ---------------------------------------------------------------------------
const memStore: Record<string, string> = {};
const localStorageStub = {
  getItem: (key: string) => memStore[key] ?? null,
  setItem: (key: string, value: string) => { memStore[key] = value; },
  removeItem: (key: string) => { delete memStore[key]; },
  clear: () => { for (const k of Object.keys(memStore)) delete memStore[k]; },
};
(globalThis as unknown as { localStorage: typeof localStorageStub }).localStorage = localStorageStub;

// Import AFTER stubbing localStorage
import { usePanelStore } from "../../../src/web/stores/panel-store";
import { useWindowStore } from "../../../src/web/components/floating-window/window-store";
import { DOCK_PANEL_ID, isWindowPanelId, windowPanelId } from "../../../src/web/stores/panel-utils";
import type { Panel } from "../../../src/web/stores/panel-utils";

function makePanel(id: string, tabSpecs: { id: string; type: string; metadata?: Record<string, unknown> }[]): Panel {
  return {
    id,
    tabs: tabSpecs.map((t) => ({
      id: t.id,
      type: t.type as Panel["tabs"][number]["type"],
      title: t.id,
      projectId: "proj1",
      closable: true,
      metadata: t.metadata,
    })),
    activeTabId: tabSpecs[0]?.id ?? null,
    tabHistory: tabSpecs.map((t) => t.id),
  };
}

function seedStore(panels: Panel[], grid: string[][], focusedPanelId: string) {
  const panelMap: Record<string, Panel> = {};
  for (const p of panels) panelMap[p.id] = p;
  panelMap[DOCK_PANEL_ID] = makePanel(DOCK_PANEL_ID, []);
  usePanelStore.setState({
    panels: panelMap,
    grid,
    focusedPanelId,
    currentProject: "proj1",
    projectGrids: {},
    projectFocused: {},
    dock: { visible: false, height: 30 },
    projectDock: {},
  });
  useWindowStore.setState({ windows: {}, restored: true });
}

/** Focus is on a panel that is still in the grid, and nothing leaked into a window. */
function expectFocusOnGrid() {
  const state = usePanelStore.getState();
  expect(isWindowPanelId(state.focusedPanelId)).toBe(false);
  expect(state.grid.flat()).toContain(state.focusedPanelId);
}

beforeEach(() => {
  localStorageStub.clear();
  useWindowStore.setState({ windows: {}, restored: true });
});

describe("focus never lands on a window panel", () => {
  it("survives re-opening a popped-out singleton through the singleton dedupe", () => {
    seedStore(
      [makePanel("panel-A", [{ id: "settings", type: "settings" }, { id: "editor:/a.ts", type: "editor" }])],
      [["panel-A"]],
      "panel-A",
    );
    const windowId = usePanelStore.getState().popOutTab("settings", "panel-A")!;
    expect(usePanelStore.getState().panels[windowPanelId(windowId)]?.tabs).toHaveLength(1);

    // Clicking "Settings" in the nav rail while it is detached.
    usePanelStore.getState().openTab({ type: "settings", title: "Settings", projectId: "proj1", closable: true });

    expectFocusOnGrid();

    // The next tab with no explicit panel must land in the grid, not in the window.
    usePanelStore.getState().openTab({
      type: "editor", title: "b.ts", projectId: "proj1", closable: true, metadata: { filePath: "/b.ts" },
    });
    const state = usePanelStore.getState();
    expect(state.panels["panel-A"]?.tabs.map((t) => t.id)).toContain("editor:/b.ts");
    expect(state.panels[windowPanelId(windowId)]?.tabs.map((t) => t.id)).toEqual(["settings"]);
  });

  it("survives setActiveTab on a popped-out singleton", () => {
    seedStore(
      [makePanel("panel-A", [{ id: "settings", type: "settings" }, { id: "editor:/a.ts", type: "editor" }])],
      [["panel-A"]],
      "panel-A",
    );
    const windowId = usePanelStore.getState().popOutTab("settings", "panel-A")!;

    // Any caller that activates a tab by id alone: send-to-chat, open-resource-tab, URL sync.
    usePanelStore.getState().setActiveTab("settings");

    expectFocusOnGrid();

    usePanelStore.getState().openTab({
      type: "editor", title: "b.ts", projectId: "proj1", closable: true, metadata: { filePath: "/b.ts" },
    });
    const state = usePanelStore.getState();
    expect(state.panels["panel-A"]?.tabs.map((t) => t.id)).toContain("editor:/b.ts");
    expect(state.panels[windowPanelId(windowId)]?.tabs.map((t) => t.id)).toEqual(["settings"]);
  });

  it("survives re-opening a popped-out chat session through the sessionId dedupe", () => {
    seedStore(
      [makePanel("panel-A", [
        { id: "chat:cc/s1", type: "chat", metadata: { sessionId: "s1", providerId: "cc" } },
        { id: "editor:/a.ts", type: "editor" },
      ])],
      [["panel-A"]],
      "panel-A",
    );
    const windowId = usePanelStore.getState().popOutTab("chat:cc/s1", "panel-A")!;

    // Re-opening the same session from history matches on sessionId, not tab id.
    const focused = usePanelStore.getState().openTab({
      type: "chat", title: "Chat", projectId: "proj1", closable: true,
      metadata: { sessionId: "s1", providerId: "cc" },
    });
    expect(focused).toBe("chat:cc/s1");

    expectFocusOnGrid();

    usePanelStore.getState().openTab({
      type: "editor", title: "b.ts", projectId: "proj1", closable: true, metadata: { filePath: "/b.ts" },
    });
    const state = usePanelStore.getState();
    expect(state.panels["panel-A"]?.tabs.map((t) => t.id)).toContain("editor:/b.ts");
    expect(state.panels[windowPanelId(windowId)]?.tabs.map((t) => t.id)).toEqual(["chat:cc/s1"]);
  });

  it("survives setActiveTab on a popped-out chat session", () => {
    seedStore(
      [makePanel("panel-A", [
        { id: "chat:cc/s1", type: "chat", metadata: { sessionId: "s1", providerId: "cc" } },
        { id: "editor:/a.ts", type: "editor" },
      ])],
      [["panel-A"]],
      "panel-A",
    );
    usePanelStore.getState().popOutTab("chat:cc/s1", "panel-A");

    usePanelStore.getState().setActiveTab("chat:cc/s1");

    expectFocusOnGrid();
  });

  it("never persists a window panel id as the focused panel", () => {
    seedStore(
      [makePanel("panel-A", [{ id: "settings", type: "settings" }, { id: "editor:/a.ts", type: "editor" }])],
      [["panel-A"]],
      "panel-A",
    );
    usePanelStore.getState().popOutTab("settings", "panel-A");
    usePanelStore.getState().setActiveTab("settings");

    const raw = localStorageStub.getItem("ppm-panels-proj1");
    expect(raw).toBeTruthy();
    const layout = JSON.parse(raw!) as { focusedPanelId: string };
    expect(isWindowPanelId(layout.focusedPanelId)).toBe(false);
  });
});
