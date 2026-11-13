/**
 * `ui_move_tab` on the device: a tab moves into an open panel, a new split or a floating window
 * through the same store actions drag and drop uses, the answer says where it was so the agent can
 * move it back, and a phone, the Assistant's own tab and a move the layout has no room for are
 * refused with nothing changed.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { useWindowStore } = await import("../../../src/web/components/floating-window/window-store");
const { DOCK_PANEL_ID } = await import("../../../src/web/stores/panel-utils");
const initialPanels = usePanelStore.getState();
afterAll(() => {
  usePanelStore.setState(initialPanels, true);
  useWindowStore.setState({ windows: {} });
  localStorage.clear();
  uninstallDom();
});
const { moveAssistantTab } = await import("../../../src/web/lib/assistant-ui/assistant-move-tab");
const { answerAssistantUi } = await import("../../../src/web/lib/assistant-ui/answer-assistant-ui");

type AnyTab = { id: string; type: string; title: string; projectId: string | null; closable: boolean; metadata?: Record<string, unknown> };
const tab = (id: string, type = "editor"): AnyTab => ({ id, type, title: id, projectId: "a", closable: true, metadata: { projectName: "a" } });
const panel = (id: string, tabs: AnyTab[]) => ({ id, tabs, activeTabId: tabs[0]?.id ?? null, tabHistory: tabs.map((t) => t.id) });

function seed(opts: { mobile?: boolean; grid?: string[][]; extra?: Record<string, ReturnType<typeof panel>> } = {}) {
  localStorage.clear();
  useWindowStore.setState({ windows: {}, restored: true } as never);
  usePanelStore.setState({
    currentProject: "a", focusedPanelId: "p1", grid: opts.grid ?? [["p1", "p2"]], lastFocusedChatProviders: {},
    projectGrids: { a: opts.grid ?? [["p1", "p2"]] }, projectFocused: { a: "p1" },
    dock: { visible: false, height: 30 }, projectDock: {},
    panels: {
      p1: panel("p1", [tab("assistant", "assistant"), tab("e1"), tab("e2")]),
      p2: panel("p2", [tab("e3")]),
      [DOCK_PANEL_ID]: panel(DOCK_PANEL_ID, [tab("terminal:1", "terminal")]),
      ...opts.extra,
    },
    isMobile: () => opts.mobile ?? false,
  } as never);
}
const panelOf = (tabId: string) => usePanelStore.getState().getPanelForTab(tabId)!;

describe("moving a tab", () => {
  beforeEach(() => seed());

  it("into an open panel at an index, answering where it was", () => {
    const res = moveAssistantTab({ tabId: "e1", to: "panel", panelId: "p2", index: 0 });
    expect(panelOf("e1").id).toBe("p2");
    expect(panelOf("e1").tabs.map((t) => t.id)).toEqual(["e1", "e3"]);
    expect(res).toEqual({
      tabId: "e1", project: "a", previousPanelClosed: false,
      now: { panelId: "p2", area: "grid", index: 0, position: { row: 0, col: 1 } },
      previous: { panelId: "p1", area: "grid", index: 1, position: { row: 0, col: 0 } },
    });
    // Moving it back with what the answer gave puts it where it was.
    moveAssistantTab({ tabId: "e1", to: "panel", panelId: res.previous.panelId, index: res.previous.index });
    expect(panelOf("e1").tabs.map((t) => t.id)).toEqual(["assistant", "e1", "e2"]);
  });

  it("into a new split to the right or below, and says when its panel went away", () => {
    const right = moveAssistantTab({ tabId: "e2", to: "split", panelId: "p1" });
    expect(usePanelStore.getState().grid[0]).toEqual(["p1", right.now.panelId, "p2"]);
    const down = moveAssistantTab({ tabId: "e3", to: "split", panelId: "p1", direction: "down" });
    expect(down.now.position).toEqual({ row: 1, col: 0 });
    // e3 was alone in p2, so p2 closed when it left.
    expect(down.previousPanelClosed).toBe(true);
    expect(usePanelStore.getState().panels.p2).toBeUndefined();
  });

  it("splits a dock terminal into the grid, the way dragging it does", () => {
    const res = moveAssistantTab({ tabId: "terminal:1", to: "split", panelId: "p2" });
    expect(res.previous).toMatchObject({ panelId: DOCK_PANEL_ID, area: "dock" });
    expect(res.now.area).toBe("grid");
    expect(usePanelStore.getState().grid[0]).toEqual(["p1", "p2", res.now.panelId]);
    expect(usePanelStore.getState().panels[DOCK_PANEL_ID]).toBeDefined();
  });

  it("into a floating window and back out of it", () => {
    const res = moveAssistantTab({ tabId: "e2", to: "window" });
    expect(res.window).toBeString();
    expect(res.now).toMatchObject({ area: "window", index: 0 });
    expect(Object.keys(useWindowStore.getState().windows)).toEqual([res.window!]);
    const back = moveAssistantTab({ tabId: "e2", to: "panel", panelId: "p1" });
    expect(back.previousPanelClosed).toBe(true);
    expect(panelOf("e2").id).toBe("p1");
  });

  it("parks a terminal in the dock and shows it", () => {
    moveAssistantTab({ tabId: "terminal:1", to: "panel", panelId: "p2" });
    const res = moveAssistantTab({ tabId: "terminal:1", to: "panel", panelId: DOCK_PANEL_ID });
    expect(res.now.area).toBe("dock");
    expect(usePanelStore.getState().dock.visible).toBe(true);
  });
});

describe("what it refuses, changing nothing", () => {
  beforeEach(() => seed());
  const layout = () => JSON.stringify([usePanelStore.getState().grid, Object.values(usePanelStore.getState().panels).map((p) => p.tabs.map((t) => t.id))]);

  it("a phone, which has no splits or windows", () => {
    seed({ mobile: true });
    const before = layout();
    expect(() => moveAssistantTab({ tabId: "e1", to: "split" })).toThrow("This device is a phone");
    expect(layout()).toBe(before);
  });

  it("the Assistant's own tab, an unknown tab, and destinations that cannot take it", () => {
    const before = layout();
    expect(() => moveAssistantTab({ tabId: "assistant", to: "window" })).toThrow("Assistant's own tab");
    expect(() => moveAssistantTab({ tabId: "missing", to: "window" })).toThrow("ui_get_state");
    expect(() => moveAssistantTab({ tabId: "e1", to: "panel", panelId: DOCK_PANEL_ID })).toThrow("The dock takes only");
    expect(() => moveAssistantTab({ tabId: "e1", to: "panel", panelId: "nope" })).toThrow("`panelId` must name");
    expect(() => moveAssistantTab({ tabId: "e1", to: "panel", panelId: "p1" })).toThrow("already in that panel");
    expect(() => moveAssistantTab({ tabId: "e3", to: "split", panelId: "p2" })).toThrow("alone in its panel");
    expect(() => moveAssistantTab({ tabId: "e1", to: "split", direction: "left" })).toThrow("`direction`");
    expect(() => moveAssistantTab({ tabId: "e1", to: "somewhere" })).toThrow("`to` must be");
    expect(layout()).toBe(before);
  });

  it("a split the grid has no room for, leaving a dock tab in the dock", () => {
    seed({ grid: [["p1", "p2", "p3"]], extra: { p3: panel("p3", [tab("e4")]) } });
    const before = layout();
    expect(() => moveAssistantTab({ tabId: "terminal:1", to: "split", panelId: "p1" })).toThrow("no room for another panel");
    expect(layout()).toBe(before);
  });
});

describe("the request on the Assistant's chat socket", () => {
  it("answers move_tab, and a phone's refusal as an error the agent reads", async () => {
    seed();
    const sent: any[] = [];
    await answerAssistantUi({ type: "assistant_ui", requestId: "r1", op: "move_tab", args: { tabId: "e1", to: "panel", panelId: "p2" } },
      { projectName: "__assistant__", sessionId: "S" }, (d) => sent.push(JSON.parse(d)));
    expect(sent[0]).toMatchObject({ requestId: "r1", ok: true, data: { tabId: "e1", now: { panelId: "p2" } } });
    seed({ mobile: true });
    await answerAssistantUi({ type: "assistant_ui", requestId: "r2", op: "move_tab", args: { tabId: "e1", to: "window" } },
      { projectName: "__assistant__", sessionId: "S" }, (d) => sent.push(JSON.parse(d)));
    expect(sent[1]).toMatchObject({ requestId: "r2", ok: false });
    expect(sent[1].error).toContain("phone");
  });
});
