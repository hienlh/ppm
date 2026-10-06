/**
 * A table's "Rows: N" in the status bar, where DBGate shows a lone grid's row count. It sat in the
 * grid's corner, over the first cells of the last row read — a new row being typed in among them
 * (seen in a browser). Each table files its count under the tab it is shown in, and the bar shows
 * the one in front of the focused panel; a count that gave up is a button that counts every row.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { click, installDom, installGlobal, mount, uninstallDom, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
// Radix's focus scope, inside every dropdown and dialog, watches its content with one.
installGlobal("MutationObserver", window.MutationObserver);
afterAll(uninstallDom);

const { act } = await import("react");
// Latched at module load by `upgrade-button.tsx`, which the status bar holds: no update check.
sessionStorage.setItem("ppm-upgrade-test", "9.9.9");
const { StatusBar } = await import("../../../src/web/components/layout/status-bar");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { useDbRowsStatusStore } = await import("../../../src/web/stores/db-rows-status-store");
const { DbRowsStatus } = await import("../../../src/web/components/database/db-rows-status");
const { TableView } = await import("../../../src/web/components/database/table/table-tab");
const { SqliteViewer } = await import("../../../src/web/components/sqlite/sqlite-viewer");
type DbTabContext = import("../../../src/web/components/database/use-db-tab").DbTabContext;
type RowCountView = import("../../../src/web/components/database/glide-grid-types").RowCountView;
type Tab = import("../../../src/web/stores/tab-store").Tab;

const realFetch = globalThis.fetch;
let view: Mounted | null = null;
beforeEach(() => {
  useDbRowsStatusStore.setState({ byTab: {} });
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  globalThis.fetch = realFetch;
});

/** Two panels side by side, each with a tab in front; `focused` is the one worked in. */
function panels(left: string | null, right: string | null, focused: "left" | "right" = "left", tabs: Tab[] = []) {
  usePanelStore.setState({
    currentProject: "p", focusedPanelId: focused, grid: [["left", "right"]], lastFocusedChatProviders: {},
    panels: {
      left: { id: "left", activeTabId: left, tabHistory: left ? [left] : [], tabs },
      right: { id: "right", activeTabId: right, tabHistory: right ? [right] : [], tabs: [] },
    },
  } as never);
}
const file = (tabId: string, rowCount: RowCountView | null, onCountExactly?: () => void) =>
  act(async () => { useDbRowsStatusStore.getState().file(tabId, rowCount ? { rowCount, onCountExactly } : null); });

const COUNTING: RowCountView = { text: "Rows: 100+", counting: true, canCountExactly: false, title: "Rows loaded so far, until they are counted" };
const GAVE_UP: RowCountView = { text: "Rows: ~90,000", counting: false, canCountExactly: true, title: "Counting took too long, so this is not exact. Click to count every row." };
const shown = () => {
  const entry = document.querySelector<HTMLElement>('[role="status"], button');
  return entry ? { text: entry.textContent, button: entry.tagName === "BUTTON" } : null;
};

describe("the status bar's Rows: N", () => {
  it("shows the count of the table in front, with a spinner while it is counted", async () => {
    panels("t1", null);
    await file("t1", COUNTING);
    view = await mount(<DbRowsStatus />);
    const status = document.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.textContent).toBe("Rows: 100+");
    expect(status.title).toBe(COUNTING.title!);
    expect(status.querySelector('[aria-label="Counting"]')).not.toBeNull();
    expect(document.querySelector("button")?.outerHTML).toBeUndefined();
  });

  it("is a button once the count gave up, which counts every row", async () => {
    let asked = 0;
    panels("t1", null);
    await file("t1", GAVE_UP, () => { asked += 1; });
    view = await mount(<DbRowsStatus />);
    const b = document.querySelector<HTMLButtonElement>("button")!;
    expect(b.textContent).toBe("Rows: ~90,000");
    expect(b.title).toContain("Click to count every row");
    await click(b);
    expect(asked).toBe(1);
  });

  it("stays a plain label where nothing can count", async () => {
    panels("t1", null);
    await file("t1", { text: "Rows: Many", counting: false, canCountExactly: true });
    view = await mount(<DbRowsStatus />);
    expect(shown()).toEqual({ text: "Rows: Many", button: false });
  });

  it("shows the table in front of the focused panel only, and follows it", async () => {
    panels("t1", "t2");
    await file("t1", { text: "Rows: 7", counting: false, canCountExactly: false });
    await file("t2", { text: "Rows: 9", counting: false, canCountExactly: false });
    view = await mount(<DbRowsStatus />);
    expect(shown()?.text).toBe("Rows: 7");
    // Working in the other panel.
    await act(async () => { usePanelStore.setState({ focusedPanelId: "right" }); });
    expect(shown()?.text).toBe("Rows: 9");
    // Another tab brought to the front there, which is no table.
    await act(async () => { panels("t1", "editor", "right"); });
    expect(shown()).toBeNull();
  });

  it("is in the app's status bar", async () => {
    panels("t1", null);
    await file("t1", { text: "Rows: 7", counting: false, canCountExactly: false });
    view = await mount(<StatusBar />);
    expect(view.container.textContent).toContain("Rows: 7");
  });

  it("says nothing once the table took its count back", async () => {
    panels("t1", null);
    await file("t1", { text: "Rows: 7", counting: false, canCountExactly: false });
    view = await mount(<DbRowsStatus />);
    expect(shown()?.text).toBe("Rows: 7");
    await file("t1", null);
    expect(shown()).toBeNull();
  });
});

describe("a table files its Rows: N", () => {
  const TAB_ID = "database:5::public:orders";
  const FILE_TAB = "sqlite:/data/app.db";
  const CTX: DbTabContext = {
    target: { kind: "connection", connectionId: 5 }, conn: undefined, dbType: "postgres", dialect: "postgres",
    name: "shop", place: null, readonly: false, missing: false,
  };
  const SCHEMA = [
    { name: "id", type: "integer", nullable: false, pk: true, defaultValue: null, fk: null },
    { name: "qty", type: "integer", nullable: true, pk: false, defaultValue: null, fk: null },
  ];
  const realWidth = window.innerWidth;

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      // A saved connection's table, and a database file's (`/connections/file/…?path=`).
      const at = (path: string) => url.startsWith(`/api/db/connections/5${path}`) || url.startsWith(`/api/db/connections/file${path}`);
      if (at("/objects")) return json({ ok: true, data: { schemas: [], objects: [{ schema: null, name: "orders", kind: "table" }] } });
      if (at("/schema")) return json({ ok: true, data: SCHEMA });
      if (at("/grid/count")) return json({ ok: true, data: { count: 2, estimate: null } });
      if (at("/grid") && init?.method === "POST") {
        return json({ ok: true, data: { columns: SCHEMA.map((c) => ({ name: c.name, type: c.type })), rows: [[1, 7], [2, 3]], hasMore: false, sql: "SELECT", rowKey: ["id"] } });
      }
      return new Response(JSON.stringify({ ok: false, error: `no stub for ${url}` }), { status: 404 });
    }) as typeof fetch;
  });
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: realWidth, configurable: true });
  });

  const settle = () => act(async () => { await Bun.sleep(5); });
  const filed = (tabId: string) => useDbRowsStatusStore.getState().byTab[tabId]?.rowCount.text;
  /** A "Rows: N" box anywhere in the view: the grid's corner had one. */
  const rowsBox = () => [...document.querySelectorAll('[role="status"], button')].find((e) => e.textContent?.startsWith("Rows:"));

  it("under its own tab once the rows are read, not over the grid, and takes it back when it goes", async () => {
    const tab: Tab = { id: TAB_ID, type: "database", title: "orders", projectId: null, closable: true, metadata: { connectionId: 5, schemaName: "public", tableName: "orders" } };
    panels(TAB_ID, null, "left", [tab]);
    view = await mount(<TableView tab={CTX} table="orders" schemaName="public" tabId={TAB_ID} />);
    await settle();
    await settle();
    expect(filed(TAB_ID)).toBe("Rows: 2");
    expect(rowsBox()?.outerHTML).toBeUndefined();
    await view.unmount();
    view = null;
    expect(useDbRowsStatusStore.getState().byTab).toEqual({});
  });

  it("under a database file's tab, for the table picked in it", async () => {
    // That tab changes table, so it keeps no table view of its own: the count still goes under it.
    const metadata = { filePath: "/data/app.db", projectName: "p", tableName: "orders" };
    const tab: Tab = { id: FILE_TAB, type: "sqlite", title: "app.db", projectId: null, closable: true, metadata };
    panels(FILE_TAB, null, "left", [tab]);
    view = await mount(<SqliteViewer metadata={metadata} tabId={FILE_TAB} />);
    for (let i = 0; i < 4; i++) await settle();
    expect(filed(FILE_TAB)).toBe("Rows: 2");
  });
});
