/**
 * DBGate's unsaved dot: a Query tab whose SQL differs from what it opened with holds text kept
 * nowhere else, so its tab says so — and a tab of any other kind never does, whatever its
 * metadata happens to carry. Closing such a tab asks first, with the Structure tab's question.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { renderToStaticMarkup } = await import("react-dom/server");
const { DraggableTab } = await import("../../../src/web/components/layout/draggable-tab");
const { queryTabMetadata } = await import("../../../src/web/lib/db-tabs");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { closeTabsAsked, settleTabClose, useTabCloseConfirm } = await import("../../../src/web/stores/tab-close-confirm-store");
type Tab = import("../../../src/web/stores/tab-store").Tab;

const Icon = () => null;
const noop = () => {};
const render = (tab: Tab) => renderToStaticMarkup(
  <DraggableTab
    tab={tab} isActive={false} icon={Icon} showDropBefore={false}
    onSelect={noop} onClose={noop} onDragStart={noop} onDragOver={noop} onDragEnd={noop} tabRef={noop}
  />,
);
const hasDot = (html: string) => html.includes('aria-label="Unsaved"');
const query = (metadata: Record<string, unknown>): Tab => ({ id: "db-query:q1", type: "db-query", title: "Query 1", projectId: null, closable: true, metadata });

describe("a Query tab's unsaved dot", () => {
  it("shows once the SQL was edited, and not while it is what the tab opened with", () => {
    const opened = queryTabMetadata("SELECT 1", 1);
    expect(hasDot(render(query(opened)))).toBe(false);
    expect(hasDot(render(query({ ...opened, currentSql: "SELECT 2" })))).toBe(true);
  });

  it("never shows on another kind of tab", () => {
    const dirty = { ...queryTabMetadata("SELECT 1", 1), currentSql: "SELECT 2" };
    expect(hasDot(render({ ...query(dirty), id: "database:5::public:users", type: "database" }))).toBe(false);
    expect(hasDot(render({ ...query(dirty), id: "editor:a.sql", type: "editor" }))).toBe(false);
  });
});

describe("closing a Query tab", () => {
  const typed: Tab = { ...query({ ...queryTabMetadata("SELECT 1", 1), currentSql: "SELECT 2" }), id: "db-query:typed" };
  const untouched: Tab = { ...query(queryTabMetadata("SELECT 1", 2)), id: "db-query:untouched", title: "Query 2" };
  beforeEach(() => {
    useTabCloseConfirm.setState({ pending: null });
    usePanelStore.setState({
      currentProject: "p", focusedPanelId: "main", grid: [["main"]],
      panels: { main: { id: "main", activeTabId: typed.id, tabHistory: [], tabs: [typed, untouched] } },
    } as never);
  });
  const open = () => usePanelStore.getState().panels.main!.tabs.map((t) => t.id);

  it("asks first while it holds SQL typed since it opened, and Cancel keeps it", async () => {
    const closing = closeTabsAsked([typed.id, untouched.id], "main");
    expect(useTabCloseConfirm.getState().pending!.tabs.map((t) => t.id)).toEqual([typed.id]);
    settleTabClose(false);
    expect(await closing).toBe(false);
    expect(open()).toEqual([typed.id, untouched.id]);
  });

  it("closes with no question while its SQL is what it opened with", async () => {
    expect(await closeTabsAsked([untouched.id], "main")).toBe(true);
    expect(useTabCloseConfirm.getState().pending).toBeNull();
    expect(open()).toEqual([typed.id]);
  });
});
