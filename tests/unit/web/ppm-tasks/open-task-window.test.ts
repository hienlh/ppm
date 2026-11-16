/**
 * `openTask` against the real panel and window stores: a desktop opens a task in a window of its
 * own and never a second window for the same task, a plain selection swaps the task in the
 * preview window, "Open as tab" moves it into the grid as a kept tab and closes the window, and a
 * phone shows the sheet instead.
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
const { useWindowStore } = await import("../../../../src/web/components/floating-window/window-store");
const { useTaskSheetStore } = await import("../../../../src/web/stores/task-sheet-store");
const { openTask, moveTaskWindowToTab, minimizeTaskWindow, taskWindowIdOf } = await import("../../../../src/web/lib/ppm-tasks/open-task");
const { isWindowPanelId } = await import("../../../../src/web/stores/panel-utils");
type Panel = import("../../../../src/web/stores/panel-utils").Panel;

const panel = (id: string, tabs: Panel["tabs"] = []): Panel => ({ id, tabs, activeTabId: tabs[0]?.id ?? null, tabHistory: tabs.map((t) => t.id) });
const chat = { id: "chat:claude/1", type: "chat" as const, title: "Chat", projectId: "alpha", closable: true, metadata: { sessionId: "1", providerId: "claude" } };
const task = (id: string, n: number) => ({ id, project: "alpha", title: `Task ${n}`, number: n });

let mobile = false;
const windowPanels = () => Object.values(usePanelStore.getState().panels).filter((p) => isWindowPanelId(p.id));
const windows = () => Object.values(useWindowStore.getState().windows);
const gridTabs = () => usePanelStore.getState().panels["p-a"]!.tabs.map((t) => `${t.id}${t.metadata?.preview ? "*" : ""}`);

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  mobile = false;
  useWindowStore.setState({ windows: {}, bounds: { w: 1440, h: 860 } });
  useTaskSheetStore.setState({ task: null });
  usePanelStore.setState({
    panels: { "p-a": panel("p-a", [chat]) },
    grid: [["p-a"]], focusedPanelId: "p-a", currentProject: "alpha", projectGrids: {},
    isMobile: () => mobile,
  });
});

describe("openTask on a desktop", () => {
  it("opens the task in a window and leaves the grid's tab alone", () => {
    openTask(task("t1", 1));
    expect(windows()).toHaveLength(1);
    expect(windows()[0]!.kind).toBe("tab-host");
    expect(windowPanels()[0]!.tabs.map((t) => t.id)).toEqual(["task:t1"]);
    expect(gridTabs()).toEqual(["chat:claude/1"]);
    expect(usePanelStore.getState().panels["p-a"]!.activeTabId).toBe("chat:claude/1");
  });

  it("opening the same task again brings its window forward instead of opening another", () => {
    openTask(task("t1", 1), { keep: true });
    openTask(task("t2", 2), { keep: true });
    const first = windowPanels().find((p) => p.tabs.some((t) => t.id === "task:t1"))!;
    openTask(task("t1", 1));
    expect(windows()).toHaveLength(2);
    const front = windows().sort((a, b) => b.rank - a.rank)[0]!;
    expect(`__win__:${front.id}`).toBe(first.id);
  });

  it("a plain selection swaps the task in the preview window, one window for the whole walk", () => {
    openTask(task("t1", 1));
    openTask(task("t2", 2));
    openTask(task("t3", 3));
    expect(windows()).toHaveLength(1);
    expect(windowPanels()[0]!.tabs.map((t) => `${t.id}${t.metadata?.preview ? "*" : ""}`)).toEqual(["task:t3*"]);
  });

  it("a kept window stays and the next selection gets a window of its own", () => {
    openTask(task("t1", 1), { keep: true });
    openTask(task("t2", 2));
    expect(windows()).toHaveLength(2);
  });

  it("opens beside an open task window, stepping off it", () => {
    openTask(task("t1", 1), { keep: true });
    openTask(task("t2", 2), { keep: true });
    const [a, b] = windows().sort((x, y) => x.rank - y.rank);
    expect(b!.rect.x - a!.rect.x).toBe(28);
    expect(b!.rect.y - a!.rect.y).toBe(28);
  });

  it("Open as tab moves the task into the grid as a kept tab and closes the window", () => {
    openTask(task("t1", 1));
    const tab = windowPanels()[0]!.tabs[0]!;
    moveTaskWindowToTab(tab);
    expect(windows()).toHaveLength(0);
    expect(windowPanels()).toHaveLength(0);
    expect(gridTabs()).toEqual(["chat:claude/1", "task:t1"]);
    // Opened again, the task focuses its tab: the user chose a tab for it.
    openTask(task("t1", 1));
    expect(windows()).toHaveLength(0);
    expect(usePanelStore.getState().panels["p-a"]!.activeTabId).toBe("task:t1");
  });

  it("falls back to a tab when no window can open", () => {
    for (let i = 0; i < 8; i++) useWindowStore.getState().open("settings");
    openTask(task("t1", 1));
    expect(gridTabs()).toEqual(["chat:claude/1", "task:t1*"]);
  });
});

describe("a task window that opens a chat", () => {
  it("goes down to the dock, the task still open in it", () => {
    openTask(task("t1", 1), { keep: true });
    openTask(task("t2", 2), { keep: true });
    const [w1, w2] = windows().sort((a, b) => a.opened - b.opened);
    minimizeTaskWindow("t1");
    const after = useWindowStore.getState().windows;
    expect(after[w1!.id]!.state).toBe("minimized");
    expect(after[w2!.id]!.state).toBe("normal");
    expect(windowPanels().find((p) => p.id === `__win__:${w1!.id}`)!.tabs.map((t) => t.id)).toEqual(["task:t1"]);
    // Opened again, the task comes back from the dock rather than in a new window.
    openTask(task("t1", 1));
    expect(useWindowStore.getState().windows[w1!.id]!.state).toBe("normal");
    expect(windows()).toHaveLength(2);
  });

  it("leaves a task shown as a tab alone", () => {
    openTask(task("t1", 1));
    moveTaskWindowToTab(windowPanels()[0]!.tabs[0]!);
    useWindowStore.getState().open("settings");
    minimizeTaskWindow("t1");
    expect(windows().every((w) => w.state === "normal")).toBe(true);
    expect(taskWindowIdOf(usePanelStore.getState().panels, "t1")).toBeNull();
  });
});

describe("openTask on a phone", () => {
  it("shows the task in the sheet and opens no tab or window", () => {
    mobile = true;
    openTask(task("t1", 1));
    expect(useTaskSheetStore.getState().task).toEqual({ id: "t1", project: "alpha", title: "Task 1", number: 1 });
    expect(windows()).toHaveLength(0);
    expect(gridTabs()).toEqual(["chat:claude/1"]);
  });
});
