/**
 * Pinned tabs as VS Code has them: kept at the start of the bar through pin, drag and move, and left
 * open by Close Others / to the Right / Saved / All.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";
import { bulkCloseIds, pinnedFirst, withPinned } from "../../../src/web/lib/tab-pins";

installDom();
afterAll(uninstallDom);
const { usePanelStore } = await import("../../../src/web/stores/panel-store");

type T = { id: string; closable: boolean; pinned?: boolean };
const t = (id: string, extra: Partial<T> = {}): T => ({ id, closable: true, ...extra });
const ids = (tabs: { id: string }[]) => tabs.map((x) => x.id);
const none = () => false;

describe("pin order", () => {
  it("pins to the end of the pinned group and unpins to the first unpinned place", () => {
    let tabs = [t("a"), t("b"), t("c"), t("d")];
    tabs = withPinned(tabs, "c", true);
    expect(ids(tabs)).toEqual(["c", "a", "b", "d"]);
    tabs = withPinned(tabs, "d", true);
    expect(ids(tabs)).toEqual(["c", "d", "a", "b"]);
    tabs = withPinned(tabs, "c", false);
    expect(ids(tabs)).toEqual(["d", "c", "a", "b"]);
    expect(tabs.find((x) => x.id === "c")).not.toHaveProperty("pinned");
  });

  it("leaves the list untouched when nothing changes", () => {
    const tabs = [t("a", { pinned: true }), t("b")];
    expect(withPinned(tabs, "a", true)).toBe(tabs);
    expect(withPinned(tabs, "zz", true)).toBe(tabs);
    expect(pinnedFirst(tabs)).toEqual(tabs);
  });

  it("puts pins first, keeping each group's order", () => {
    expect(ids(pinnedFirst([t("a"), t("p1", { pinned: true }), t("b"), t("p2", { pinned: true })]))).toEqual(["p1", "p2", "a", "b"]);
  });
});

describe("bulk closes skip pinned tabs", () => {
  const tabs = [t("p", { pinned: true }), t("a"), t("dirty"), t("fixed", { closable: false }), t("b")];
  const dirty = (x: T) => x.id === "dirty";

  it("Close Others", () => expect(bulkCloseIds(tabs, "a", "others", none)).toEqual(["dirty", "b"]));
  it("Close to the Right", () => expect(bulkCloseIds(tabs, "dirty", "right", none)).toEqual(["b"]));
  it("Close Saved keeps unsaved work", () => expect(bulkCloseIds(tabs, "a", "saved", dirty)).toEqual(["a", "b"]));
  it("Close All, opened on a pinned tab, still keeps it", () => expect(bulkCloseIds(tabs, "p", "all", none)).toEqual(["a", "dirty", "b"]));
});

describe("panel store keeps pins first", () => {
  const ed = (id: string) => ({ id, type: "editor" as const, title: id, projectId: "p", closable: true, metadata: { filePath: id } });
  beforeEach(() => {
    usePanelStore.setState({
      currentProject: "p", focusedPanelId: "left", grid: [["left", "right"]], lastFocusedChatProviders: {},
      panels: {
        left: { id: "left", activeTabId: "a", tabHistory: ["a"], tabs: [ed("a"), ed("b"), ed("c")] },
        right: { id: "right", activeTabId: "x", tabHistory: ["x"], tabs: [ed("x"), ed("y")] },
      },
    } as never);
  });
  const left = () => usePanelStore.getState().panels.left!.tabs;

  it("pinning moves the tab to the front and persists the flag", () => {
    usePanelStore.getState().setTabPinned("c", true);
    expect(ids(left())).toEqual(["c", "a", "b"]);
    expect(left()[0]!.pinned).toBe(true);
  });

  it("a drag cannot put an unpinned tab before a pinned one", () => {
    usePanelStore.getState().setTabPinned("c", true);
    usePanelStore.getState().reorderTab("b", "left", 0);
    expect(ids(left())).toEqual(["c", "b", "a"]);
  });

  it("a pinned tab moved to another panel joins its pins at the front", () => {
    usePanelStore.getState().setTabPinned("y", true);
    usePanelStore.getState().setTabPinned("c", true);
    usePanelStore.getState().moveTab("c", "left", "right", 2);
    expect(ids(usePanelStore.getState().panels.right!.tabs)).toEqual(["y", "c", "x"]);
  });
});
