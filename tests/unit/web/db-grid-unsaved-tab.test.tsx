/**
 * Rows a grid has changed and not saved live only in that grid, so the tab it is in says so —
 * DBGate's unsaved dot, in the tab strip and in a phone's tab switcher — and closing the tab asks
 * first. Only rows Save would write count: once there are none, the tab closes with no question.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);
const { act } = await import("react");
const { DraggableTab } = await import("../../../src/web/components/layout/draggable-tab");
const { MobileTabSwitcherSheet } = await import("../../../src/web/components/layout/mobile-tab-switcher-sheet");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { closeTabsAsked, settleTabClose, useTabCloseConfirm } = await import("../../../src/web/stores/tab-close-confirm-store");
const { setUnsavedGridRows, unsavedGridRows, useUnsavedGridRows } = await import("../../../src/web/stores/unsaved-grid-rows-store");
type Tab = import("../../../src/web/stores/tab-store").Tab;

const TABLE: Tab = { id: "database:5::public:users", type: "database", title: "users", projectId: "p", closable: true, metadata: { connectionId: 5, tableName: "users" } };
const OTHER: Tab = { id: "database:5::public:orders", type: "database", title: "orders", projectId: "p", closable: true, metadata: { connectionId: 5, tableName: "orders" } };

beforeEach(() => {
  useUnsavedGridRows.setState({}, true);
  useTabCloseConfirm.setState({ pending: null });
  usePanelStore.setState({
    currentProject: "p", focusedPanelId: "main", grid: [["main"]],
    panels: { main: { id: "main", activeTabId: TABLE.id, tabHistory: [], tabs: [TABLE, OTHER] } },
  } as never);
});
let view: Mounted | null = null;
afterEach(async () => { await view?.unmount(); view = null; });

const Icon = () => null;
const noop = () => {};
/** The tab strip's tabs, mounted as the app mounts them: the count is read from the store as it changes. */
const strip = (tabs: Tab[]) => mount(<>{tabs.map((tab) => (
  <div key={tab.id} data-tab={tab.id}>
    <DraggableTab
      tab={tab} isActive={false} icon={Icon} showDropBefore={false}
      onSelect={noop} onClose={noop} onDragStart={noop} onDragOver={noop} onDragEnd={noop} tabRef={noop}
    />
  </div>
))}</>);
const hasDot = (tab: Tab) => !!document.body.querySelector(`[data-tab="${tab.id}"] [aria-label="Unsaved"]`);
const tabsOpen = () => usePanelStore.getState().panels.main!.tabs.map((t) => t.id);

describe("the unsaved dot", () => {
  it("shows on the tab whose grid has rows to save, and goes once it has none", async () => {
    view = await strip([TABLE, OTHER]);
    expect(hasDot(TABLE)).toBe(false);
    await act(async () => { setUnsavedGridRows(TABLE.id, 2); });
    expect([hasDot(TABLE), hasDot(OTHER)]).toEqual([true, false]);
    await act(async () => { setUnsavedGridRows(TABLE.id, 0); });
    expect(hasDot(TABLE)).toBe(false);
  });

  it("shows in a phone's tab switcher too, as the count changes", async () => {
    view = await mount(
      <MobileTabSwitcherSheet
        open onClose={noop} onOpenPalette={noop} tabs={[TABLE, OTHER]} tabPanelMap={{ [TABLE.id]: "main", [OTHER.id]: "main" }}
        panelOrder={["main"]} activeTabId={TABLE.id} projectColor={null} recency={new Map()} sessionTagMap={{}}
      />,
    );
    const dotted = () => [...document.body.querySelectorAll('[aria-label="Unsaved"]')].map((d) => d.parentElement!.textContent);
    expect(dotted()).toEqual([]);
    await act(async () => { setUnsavedGridRows(OTHER.id, 1); });
    expect(dotted()).toHaveLength(1);
    expect(dotted()[0]).toContain("orders");
    await act(async () => { setUnsavedGridRows(OTHER.id, 0); });
    expect(dotted()).toEqual([]);
  });
});

describe("closing the tab", () => {
  it("asks first while its grid has rows to save, and Cancel keeps every tab the close named", async () => {
    setUnsavedGridRows(TABLE.id, 1);
    const closing = closeTabsAsked([TABLE.id, OTHER.id], "main");
    expect(useTabCloseConfirm.getState().pending!.tabs.map((t) => t.id)).toEqual([TABLE.id]);
    settleTabClose(false);
    expect(await closing).toBe(false);
    expect(tabsOpen()).toEqual([TABLE.id, OTHER.id]);
  });

  it("closes once the person agrees, and with no question when nothing is left to save", async () => {
    setUnsavedGridRows(TABLE.id, 1);
    const closing = closeTabsAsked([TABLE.id], "main");
    settleTabClose(true);
    expect(await closing).toBe(true);
    expect(tabsOpen()).toEqual([OTHER.id]);
    setUnsavedGridRows(OTHER.id, 3);
    setUnsavedGridRows(OTHER.id, 0);
    expect(await closeTabsAsked([OTHER.id], "main")).toBe(true);
    expect(useTabCloseConfirm.getState().pending).toBeNull();
    expect(tabsOpen()).toEqual([]);
  });
});

describe("the count kept", () => {
  it("holds one number per tab, drops a tab at none, and changes nothing when told the same", () => {
    let updates = 0;
    const stop = useUnsavedGridRows.subscribe(() => { updates += 1; });
    setUnsavedGridRows("a", 2);
    setUnsavedGridRows("a", 2);
    setUnsavedGridRows("b", 1);
    setUnsavedGridRows("a", 0);
    setUnsavedGridRows("c", 0);
    stop();
    expect(useUnsavedGridRows.getState()).toEqual({ b: 1 });
    expect([unsavedGridRows("a"), unsavedGridRows("b")]).toEqual([0, 1]);
    expect(updates).toBe(3);
  });
});
