/**
 * Task tabs in the real panel store: a selection replaces the panel's preview in place, a kept
 * tab stays, and a preview that becomes a task already open in another project's kept-alive
 * panel gets an id of its own (two tabs sharing `task:<id>` would make keep, title sync and
 * close reach the wrong one).
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { installGlobal, uninstallDom } from "../../../helpers/react-dom.tsx";

const mem: Record<string, string> = {};
installGlobal("localStorage", {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
  clear: () => { for (const k of Object.keys(mem)) delete mem[k]; },
});
afterAll(uninstallDom);

const { usePanelStore } = await import("../../../../src/web/stores/panel-store");
type Panel = import("../../../../src/web/stores/panel-utils").Panel;

const panel = (id: string, tabs: Panel["tabs"] = []): Panel => ({ id, tabs, activeTabId: tabs[0]?.id ?? null, tabHistory: tabs.map((t) => t.id) });
const taskTab = (taskId: string, preview: boolean, id = `task:${taskId}`): Panel["tabs"][number] =>
  ({ id, type: "task", title: taskId, projectId: "a", closable: true, metadata: { taskId, ...(preview ? { preview: true } : {}) } });
const open = (taskId: string, preview = true) => usePanelStore.getState().openTab({
  type: "task", title: taskId, projectId: "b", closable: true, metadata: { taskId, projectName: "b", ...(preview ? { preview: true } : {}) },
});
const tabsOf = (pid: string) => usePanelStore.getState().panels[pid]!.tabs.map((t) => `${t.id}${t.metadata?.preview ? "*" : ""}`);

beforeEach(() => {
  usePanelStore.setState({
    panels: { "p-b": panel("p-b"), "p-a-hidden": panel("p-a-hidden", [taskTab("x", false)]) },
    grid: [["p-b"]], focusedPanelId: "p-b", currentProject: "b", projectGrids: { a: [["p-a-hidden"]] },
  });
});

describe("task tabs in the panel store", () => {
  it("a plain selection replaces the preview in its own slot", () => {
    open("y");
    open("z");
    expect(tabsOf("p-b")).toEqual(["task:z*"]);
    expect(usePanelStore.getState().panels["p-b"]!.activeTabId).toBe("task:z");
  });

  it("a kept tab stays and the next selection opens a preview beside it", () => {
    open("y", false);
    open("z");
    expect(tabsOf("p-b")).toEqual(["task:y", "task:z*"]);
  });

  it("re-opening a preview with keep turns it into a kept tab", () => {
    open("y");
    open("y", false);
    expect(tabsOf("p-b")).toEqual(["task:y"]);
  });

  it("a preview that becomes a task open in another project's hidden panel gets its own id", () => {
    open("y");
    const id = open("x");
    expect(id).toBe("task:x@p-b");
    expect(tabsOf("p-b")).toEqual(["task:x@p-b*"]);
    expect(tabsOf("p-a-hidden")).toEqual(["task:x"]);
  });
});
