/**
 * One tab per table's data, per table's structure and per object's SQL, as in DBGate: opening one
 * again focuses the tab already open, in whichever panel or floating window holds it — where a
 * query always opens a tab of its own. And the tabs an older version saved, in the browser's
 * storage, come back as the new ones.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { useWindowStore } = await import("../../../src/web/components/floating-window/window-store");
const { loadPanelLayout, windowPanelId } = await import("../../../src/web/stores/panel-utils");
const { loadWindowPanels } = await import("../../../src/web/stores/window-panel-persistence");
const { openQueryTab, openReferenceTab, openSqlTab, openStructureTab, openTableTab } = await import("../../../src/web/components/database/explorer/open-db-tabs");
type Tab = import("../../../src/web/stores/tab-store").Tab;

const place = { target: { kind: "connection" as const, connectionId: 5 }, connectionName: "shop", dbType: "postgres" as const };
const users = { schema: "public", name: "users" };
const WIN = windowPanelId("w1");

const tab = (id: string, type: Tab["type"], metadata: Record<string, unknown>): Tab => ({ id, type, title: id, projectId: null, closable: true, metadata });
const editor = tab("editor:a.ts", "editor", { filePath: "a.ts" });
const usersData = tab("database:5::public:users", "database", { connectionId: 5, schemaName: "public", tableName: "users" });

const realWidth = window.innerWidth;
const setWidth = (value: number) => Object.defineProperty(window, "innerWidth", { value, configurable: true });

beforeEach(() => {
  setWidth(1280);
  localStorage.clear();
  usePanelStore.setState({
    currentProject: "p", focusedPanelId: "left", grid: [["left", "right"]], lastFocusedChatProviders: {},
    panels: {
      left: { id: "left", activeTabId: editor.id, tabHistory: [editor.id], tabs: [editor] },
      right: { id: "right", activeTabId: "editor:b.ts", tabHistory: ["editor:b.ts"], tabs: [tab("editor:b.ts", "editor", { filePath: "b.ts" }), usersData] },
    },
  } as never);
  useWindowStore.setState({ windows: {} });
});
afterEach(() => setWidth(realWidth));

const panels = () => usePanelStore.getState().panels;
const allTabs = () => Object.values(panels()).flatMap((p) => p.tabs);
const ofType = (type: string) => allTabs().filter((t) => t.type === type);

describe("following a foreign key to the row it refers to", () => {
  const filters = { columns: { id: { text: '="11"' } } };

  it("opens the table as a form, filtered to the row, in a tab of its own every time — as DBGate forces a new tab", () => {
    const first = openReferenceTab(place, users, filters);
    const second = openReferenceTab(place, users, filters);
    expect(first).not.toBe(second);
    expect(first).not.toBe(usersData.id);
    expect(first.startsWith(`${usersData.id}:`)).toBe(true);
    expect(ofType("database")).toHaveLength(3);
    const opened = allTabs().find((t) => t.id === second)!;
    expect(opened.title).toBe("shop · users");
    expect(opened.metadata).toMatchObject({
      connectionId: 5, connectionName: "shop", dbType: "postgres", schemaName: "public", tableName: "users",
      filters, gridView: { form: true },
    });
    expect(typeof opened.metadata?.instance).toBe("string");
  });

  it("leaves the table's own tab to the tree: opening the table again still focuses that one", () => {
    openReferenceTab(place, users, filters);
    expect(openTableTab(place, users)).toBe(usersData.id);
  });
});

describe("opening a table's tab again", () => {
  it("focuses the data tab another panel holds instead of opening a second", () => {
    const id = openTableTab(place, users);
    expect(id).toBe(usersData.id);
    expect(ofType("database")).toHaveLength(1);
    expect(panels().right!.activeTabId).toBe(usersData.id);
    expect(usePanelStore.getState().focusedPanelId).toBe("right");
  });

  it("focuses a tab opened in a second panel, whose id carries that panel", () => {
    usePanelStore.setState((s) => ({ panels: { ...s.panels, right: { ...s.panels.right!, tabs: [{ ...usersData, id: `${usersData.id}@right` }] } } }));
    expect(openTableTab(place, users)).toBe(`${usersData.id}@right`);
    expect(ofType("database")).toHaveLength(1);
  });

  it("opens one Structure tab however many times it is asked for, beside the data tab", () => {
    const first = openStructureTab(place, users);
    expect(openStructureTab(place, users)).toBe(first);
    expect(ofType("db-structure")).toHaveLength(1);
    expect(ofType("database")).toHaveLength(1);
    // Another database of the server is another table.
    openStructureTab({ ...place, target: { ...place.target, database: "reporting" } }, users);
    expect(ofType("db-structure")).toHaveLength(2);
  });

  it("focuses the floating window holding an object's SQL and raises it", () => {
    const sqlId = "db-sql:5::public:function:f:integer:";
    usePanelStore.setState((s) => ({
      panels: { ...s.panels, [WIN]: { id: WIN, activeTabId: sqlId, tabHistory: [sqlId], tabs: [tab(sqlId, "db-sql", { connectionId: 5, schemaName: "public", objectKind: "function", objectName: "f", objectArgs: "integer" })] } },
    }));
    const rect = { x: 0, y: 0, w: 400, h: 300 };
    useWindowStore.setState({
      windows: {
        w1: { id: "w1", kind: "tabs", rect, rank: 0, state: "normal" },
        w2: { id: "w2", kind: "tabs", rect, rank: 1, state: "normal" },
      },
    } as never);

    expect(openSqlTab(place, { schema: "public", name: "f", kind: "function", args: "integer" })).toBe(sqlId);
    expect(ofType("db-sql")).toHaveLength(1);
    expect(panels()[WIN]!.activeTabId).toBe(sqlId);
    // A window is raised, never made the grid's focused panel.
    expect(useWindowStore.getState().windows.w1!.rank).toBeGreaterThan(useWindowStore.getState().windows.w2!.rank);
    expect(usePanelStore.getState().focusedPanelId).toBe("left");

    // Another overload is another tab.
    openSqlTab(place, { schema: "public", name: "f", kind: "function", args: "text" });
    expect(ofType("db-sql")).toHaveLength(2);
  });

  it("on a phone, where no window is on screen, opens a tab rather than focusing one in a window", () => {
    setWidth(390);
    usePanelStore.setState((s) => ({
      panels: {
        ...s.panels,
        right: { ...s.panels.right!, tabs: [s.panels.right!.tabs[0]!] },
        [WIN]: { id: WIN, activeTabId: usersData.id, tabHistory: [usersData.id], tabs: [usersData] },
      },
    }));
    const id = openTableTab(place, users);
    expect(panels().left!.tabs.find((t) => t.type === "database")?.id).toBe(id);
    expect(panels().left!.activeTabId).toBe(id);
    expect(panels()[WIN]!.tabs).toHaveLength(1);
  });

  it("still focuses the grid's own tab on a phone", () => {
    setWidth(390);
    expect(openTableTab(place, users)).toBe(usersData.id);
    expect(ofType("database")).toHaveLength(1);
  });
});

describe("a new query", () => {
  it("is always a tab of its own, numbered after the others", () => {
    const a = openQueryTab(place, "SELECT 1");
    const b = openQueryTab(place, "SELECT 1");
    expect(a).not.toBe(b);
    expect(ofType("db-query").map((t) => t.title)).toEqual(["Query 1", "Query 2"]);
    expect(ofType("db-query")[0]!.metadata).toMatchObject({ connectionId: 5, connectionName: "shop", dbType: "postgres", currentSql: "SELECT 1", openedSql: "SELECT 1" });
  });
});

describe("tabs an older version saved", () => {
  it("come back from a project's layout as the new tabs, under the new ids", () => {
    localStorage.setItem("ppm-panels-shop", JSON.stringify({
      grid: [["p1"]], focusedPanelId: "p1",
      panels: {
        p1: {
          id: "p1", activeTabId: "tab-q",
          tabHistory: ["postgres:1", "tab-q"],
          tabs: [
            { id: "postgres:1", type: "postgres", title: "orders", projectId: "shop", closable: true, metadata: { connectionId: 3, schemaName: "sales", tableName: "orders" } },
            { id: "tab-q", type: "database", title: "Query", projectId: "shop", closable: true, metadata: { connectionId: 3, queryId: "q9", initialSql: "SELECT 9" } },
            { id: "postgres:2", type: "postgres", title: "pg", projectId: "shop", closable: true, metadata: { connectionString: "postgres://x" } },
          ],
        },
      },
    }));
    const layout = loadPanelLayout("shop")!;
    const p1 = layout.panels.p1!;
    expect(p1.tabs.map((t) => [t.id, t.type])).toEqual([["database:3::sales:orders", "database"], ["db-query:q9", "db-query"]]);
    expect(p1.tabs[1]!.metadata).toMatchObject({ currentSql: "SELECT 9", openedSql: "SELECT 9" });
    expect(p1.activeTabId).toBe("db-query:q9");
    expect(p1.tabHistory).toEqual(["database:3::sales:orders", "db-query:q9"]);
  });

  it("come back in a floating window as the new tabs, where an old Postgres tab would fail the window's check", () => {
    localStorage.setItem("ppm-window-panels", JSON.stringify({
      [WIN]: {
        id: WIN, activeTabId: "postgres:1", tabHistory: ["postgres:1"],
        tabs: [{ id: "postgres:1", type: "postgres", title: "orders", projectId: null, closable: true, metadata: { connectionId: 3, tableName: "orders" } }],
      },
    }));
    const restored = loadWindowPanels()[WIN]!;
    expect(restored.tabs.map((t) => [t.id, t.type])).toEqual([["database:3:::orders", "database"]]);
    expect(restored.activeTabId).toBe("database:3:::orders");
  });
});
