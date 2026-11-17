/**
 * A session picked in Chat History must open where the user can see it.
 *
 * After PPM had been open a long time, clicking an old session did nothing at all until every
 * tab was closed. Opening a chat with no panel named lands in the focused panel, and focus
 * could end up on a panel that is not on screen — another project's kept panel, or one that no
 * longer exists — so the tab was "opened" out of sight, or `openTab` returned "" silently.
 * Each case below is a state the store reaches through its own actions.
 */
import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { openSessionInItsTab } = await import("../../../src/web/lib/design/open-design-tab");
const { savePanelLayout, DOCK_PANEL_ID, createDockPanel } = await import("../../../src/web/stores/panel-utils");
type Panel = import("../../../src/web/stores/panel-utils").Panel;
type Tab = import("../../../src/web/stores/tab-store").Tab;

const warn = spyOn(console, "warn").mockImplementation(() => {});
afterAll(() => warn.mockRestore());

const editor = (id: string, project: string): Tab =>
  ({ id, type: "editor", title: id, projectId: project, closable: true, metadata: { filePath: id } });
const chat = (id: string, project: string, sessionId: string): Tab =>
  ({ id, type: "chat", title: id, projectId: project, closable: true, metadata: { projectName: project, sessionId, providerId: "claude" } });
const panel = (id: string, tabs: Tab[]): Panel =>
  ({ id, tabs, activeTabId: tabs[0]?.id ?? null, tabHistory: tabs.map((t) => t.id) });

/** Project B is open with two panels; project A's two-panel grid is kept alive behind it. */
function seed(panels: Panel[], extra: Record<string, unknown> = {}) {
  localStorage.clear();
  const map: Record<string, Panel> = { [DOCK_PANEL_ID]: createDockPanel() };
  for (const p of panels) map[p.id] = p;
  usePanelStore.setState({
    currentProject: "proj-b", grid: [["b1", "b2"]], focusedPanelId: "b1",
    projectGrids: { "proj-a": [["a1", "a2"]] }, projectFocused: { "proj-a": "a2" },
    projectDock: {}, dock: { visible: false, height: 30 }, lastFocusedChatProviders: {},
    panels: map, ...extra,
  } as never);
}

const state = () => usePanelStore.getState();
const onGrid = (panelId: string) => state().grid.flat().includes(panelId);
/** The panel holding `tabId`, which must be on the open grid with that tab showing. */
function expectShown(tabId: string) {
  expect(tabId).not.toBe("");
  const holder = Object.values(state().panels).find((p) => p.tabs.some((t) => t.id === tabId));
  expect(holder?.id && onGrid(holder.id)).toBe(true);
  expect(holder?.activeTabId).toBe(tabId);
  expect(state().focusedPanelId).toBe(holder!.id);
}

beforeEach(() => warn.mockClear());

describe("a session picked in the history opens on screen", () => {
  it("after a tab closed in another project's kept panel emptied it", () => {
    seed([
      panel("a1", [editor("editor:a.ts", "proj-a")]),
      panel("a2", [chat("chat:x", "proj-a", "sess-x")]),
      panel("b1", [editor("editor:b.ts", "proj-b")]),
      panel("b2", [editor("editor:c.ts", "proj-b")]),
    ]);
    // A chat closing itself while its project is out of sight (a design redirect, a deleted
    // design's tabs, a kept-alive tab's own effect) empties A's focused panel.
    state().closeTab("chat:x", "a2");
    state().switchProject("proj-a");

    // A's grid never names a panel that is gone, nor does its focus.
    for (const id of state().grid.flat()) expect(state().panels[id]).toBeDefined();
    expect(state().panels[state().focusedPanelId]).toBeDefined();

    expectShown(openSessionInItsTab({ id: "sess-old", providerId: "claude", title: "Old" }, "proj-a"));
  });

  it("after a same-id tab in another project's kept panel was activated by id", () => {
    // Both projects have a README open: the id is the same. A's panel was loaded first.
    seed([
      panel("a1", [editor("editor:README.md", "proj-a")]),
      panel("a2", [editor("editor:a.ts", "proj-a")]),
      panel("b1", [editor("editor:b.ts", "proj-b"), editor("editor:README.md", "proj-b")]),
      panel("b2", [editor("editor:c.ts", "proj-b")]),
    ]);
    // Activating by id alone (URL back/forward, a keybinding) must pick the one on screen.
    state().setActiveTab("editor:README.md");
    expect(onGrid(state().focusedPanelId)).toBe(true);
    expect(state().panels.b1!.activeTabId).toBe("editor:README.md");

    expectShown(openSessionInItsTab({ id: "sess-old", providerId: "claude", title: "Old" }, "proj-b"));
  });

  it("when the session is already open in a panel nobody sees, and for every open after it", () => {
    // B's chat sits in A's kept grid (opened there before a switch); to the user it is not open.
    seed([
      panel("a1", [editor("editor:a.ts", "proj-a")]),
      panel("a2", [editor("editor:a2.ts", "proj-a"), chat("chat:old", "proj-b", "sess-old")]),
      panel("b1", [editor("editor:b.ts", "proj-b")]),
      panel("b2", [editor("editor:c.ts", "proj-b")]),
    ]);
    const id = openSessionInItsTab({ id: "sess-old", providerId: "claude", title: "Old" }, "proj-b");
    expect(id).toBe("chat:old");
    expectShown(id);
    // Moved, not copied: one tab answers to the session.
    expect(Object.values(state().panels).flatMap((p) => p.tabs).filter((t) => t.id === "chat:old")).toHaveLength(1);

    expectShown(openSessionInItsTab({ id: "sess-next", providerId: "claude", title: "Next" }, "proj-b"));
  });

  it("when focus already names a panel that is gone", () => {
    seed([
      panel("b1", [editor("editor:b.ts", "proj-b")]),
      panel("b2", [editor("editor:c.ts", "proj-b")]),
    ], { focusedPanelId: "gone" });
    expectShown(openSessionInItsTab({ id: "sess-old", providerId: "claude", title: "Old" }, "proj-b"));
    expect(warn).toHaveBeenCalled();
  });

  it("after a reload of the open project whose saved layout lost a split made since its load", () => {
    seed([
      panel("b1", [editor("editor:b.ts", "proj-b"), chat("chat:old", "proj-b", "sess-old")]),
    ], { grid: [["b1"]], projectGrids: { "proj-b": [["b1"]] }, projectFocused: { "proj-b": "b1" } });
    state().splitPanel("right", "chat:old", "b1");
    const split = state().grid.flat().find((id) => id !== "b1")!;
    // Another device rewrote B's layout without that split.
    savePanelLayout("proj-b", { panels: { b1: panel("b1", [editor("editor:b.ts", "proj-b")]) }, grid: [["b1"]], focusedPanelId: "b1" });

    state().reloadProject("proj-b");

    expect(state().panels[split]).toBeUndefined();
    expectShown(openSessionInItsTab({ id: "sess-old", providerId: "claude", title: "Old" }, "proj-b"));
  });
});
