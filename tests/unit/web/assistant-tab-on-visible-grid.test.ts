/**
 * The PPM Assistant is one tab that belongs to no project. Each project keeps its own grid
 * and the other projects' grids stay mounted out of sight, so "focus the one that is open"
 * used to activate the Assistant inside a grid nobody could see — on a phone, switching
 * project and reopening the Assistant showed nothing. It must come to the grid on screen.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
// The store outlives this file in the test process: put back what it was, `isMobile` included.
const initialPanels = usePanelStore.getState();
afterAll(() => {
  usePanelStore.setState(initialPanels, true);
  localStorage.clear();
  uninstallDom();
});
const { openAssistant, ASSISTANT_TAB_ID } = await import("../../../src/web/components/assistant/open-assistant");
const { relocateTab, isPanelOnScreen, projectOwningPanel } = await import("../../../src/web/stores/singleton-tab-relocation");

const assistantTab = (sessionId?: string) => ({
  id: ASSISTANT_TAB_ID, type: "assistant" as const, title: "PPM Assistant", projectId: null, closable: true,
  metadata: { projectName: "__assistant__", providerId: "claude", ...(sessionId ? { sessionId } : {}), assistantChatEpoch: 1 },
});
const editor = (id: string, project: string) => ({
  id, type: "editor" as const, title: id, projectId: project, closable: true, metadata: { filePath: id, projectName: project },
});

function seed(mobile: boolean, assistantIn: "hidden" | "visible") {
  const hidden = { id: "a1", activeTabId: assistantIn === "hidden" ? ASSISTANT_TAB_ID : "editor:a.ts", tabHistory: [],
    tabs: [editor("editor:a.ts", "a"), ...(assistantIn === "hidden" ? [assistantTab("s1")] : [])] };
  const visible = { id: "b1", activeTabId: "editor:b.ts", tabHistory: [],
    tabs: [editor("editor:b.ts", "b"), ...(assistantIn === "visible" ? [assistantTab("s1")] : [])] };
  localStorage.setItem("ppm-panels-a", JSON.stringify({ panels: { a1: hidden }, grid: [["a1"]], focusedPanelId: "a1" }));
  usePanelStore.setState({
    currentProject: "b", focusedPanelId: "b1", grid: [["b1"]], lastFocusedChatProviders: {},
    projectGrids: { a: [["a1"]] }, projectFocused: { a: "a1" },
    panels: { a1: hidden, b1: visible },
    isMobile: () => mobile,
  } as never);
}

const panel = (id: string) => usePanelStore.getState().panels[id]!;
const assistantCount = () => Object.values(usePanelStore.getState().panels)
  .flatMap((p) => p.tabs).filter((t) => t.type === "assistant").length;

beforeEach(() => localStorage.clear());

describe("reopening the Assistant after a project switch", () => {
  for (const mobile of [true, false]) {
    it(`brings it from the hidden project's grid onto the visible one (${mobile ? "phone" : "desktop"})`, () => {
      seed(mobile, "hidden");
      const id = openAssistant();
      expect(id).toBe(ASSISTANT_TAB_ID);
      expect(panel("b1").activeTabId).toBe(ASSISTANT_TAB_ID);
      expect(panel("b1").tabs.map((t) => t.id)).toContain(ASSISTANT_TAB_ID);
      expect(panel("a1").tabs.map((t) => t.id)).not.toContain(ASSISTANT_TAB_ID);
      expect(assistantCount()).toBe(1);
      // The live session stays the one it was showing.
      expect(panel("b1").tabs.find((t) => t.id === ASSISTANT_TAB_ID)!.metadata!.sessionId).toBe("s1");
    });
  }

  it("keeps the hidden project's panel, so its remembered grid still names a real panel", () => {
    seed(true, "hidden");
    openAssistant();
    expect(panel("a1")).toBeDefined();
    expect(usePanelStore.getState().projectGrids.a).toEqual([["a1"]]);
    expect(panel("a1").activeTabId).toBe("editor:a.ts");
  });

  it("writes the hidden project's saved layout without it, so a reload does not bring a second copy", () => {
    seed(true, "hidden");
    openAssistant();
    const saved = JSON.parse(localStorage.getItem("ppm-panels-a")!);
    expect(saved.panels.a1.tabs.map((t: { id: string }) => t.id)).toEqual(["editor:a.ts"]);
  });

  it("focuses it where it is when it is already on the visible grid", () => {
    seed(true, "visible");
    openAssistant();
    expect(panel("b1").activeTabId).toBe(ASSISTANT_TAB_ID);
    expect(assistantCount()).toBe(1);
  });

  it("switches the open Assistant to a requested session and remounts its chat", () => {
    seed(true, "visible");
    openAssistant({ sessionId: "s2", providerId: "codex" });
    const meta = panel("b1").tabs.find((t) => t.id === ASSISTANT_TAB_ID)!.metadata!;
    expect(meta.sessionId).toBe("s2");
    expect(meta.providerId).toBe("codex");
    expect(meta.assistantChatEpoch).toBe(2);
  });

  it("opens a new one on the visible grid, with no project and the virtual project only in metadata", () => {
    seed(true, "visible");
    usePanelStore.setState((s) => ({ panels: { ...s.panels, b1: { ...s.panels.b1!, tabs: [editor("editor:b.ts", "b")] } } }));
    openAssistant();
    const tab = panel("b1").tabs.find((t) => t.id === ASSISTANT_TAB_ID)!;
    expect(tab.projectId).toBeNull();
    expect(tab.metadata!.projectName).toBe("__assistant__");
  });
});

describe("the relocation helpers", () => {
  it("tells on-screen panels from hidden ones", () => {
    expect(isPanelOnScreen("b1", [["b1"]], true)).toBe(true);
    expect(isPanelOnScreen("a1", [["b1"]], false)).toBe(false);
    expect(isPanelOnScreen("__dock__", [["b1"]], true)).toBe(true);
    expect(isPanelOnScreen("__win__:w1", [["b1"]], false)).toBe(true);
    expect(isPanelOnScreen("__win__:w1", [["b1"]], true)).toBe(false);
  });

  it("finds the project whose grid owns a panel", () => {
    expect(projectOwningPanel({ a: [["a1", "a2"]], c: [["c1"]] }, "a2")).toBe("a");
    expect(projectOwningPanel({ a: [["a1"]] }, "zz")).toBeNull();
  });

  it("moves a tab without dropping the emptied source", () => {
    const tab = assistantTab();
    const out = relocateTab({
      a1: { id: "a1", tabs: [tab], activeTabId: tab.id, tabHistory: [tab.id] },
      b1: { id: "b1", tabs: [], activeTabId: null, tabHistory: [] },
    }, tab.id, "a1", "b1");
    expect(out.a1).toEqual({ id: "a1", tabs: [], activeTabId: null, tabHistory: [] });
    expect(out.b1!.activeTabId).toBe(tab.id);
    expect(out.b1!.tabHistory).toEqual([tab.id]);
  });
});
