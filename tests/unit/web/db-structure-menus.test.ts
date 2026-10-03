/**
 * The tree's structure commands — DBGate's Drop, Rename, Truncate and Create table backup on a
 * table, Rename and Drop on a column, New table on a database — are offered only on a desktop and
 * only through a connection that takes writes, and none of them changes anything by itself: each
 * asks Save changes, which shows the script first. A rename asks for the new name before that.
 * Export and Import open the Import/Export tab, on a desktop; Import never on a read-only connection.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { installDom, mount, uninstallDom } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { objectMenu, columnMenu, newObjectMenu } = await import("../../../src/web/components/database/object-tree/object-menus");
const { connectionMenu, databaseMenu } = await import("../../../src/web/components/database/connections-section/connection-menus");
const { useStructureSave } = await import("../../../src/web/components/database/table-editor/structure-save-store");
const { _resetDbExplorer } = await import("../../../src/web/components/database/explorer/db-explorer-store");
const { useTabStore } = await import("../../../src/web/stores/tab-store");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");
const { useDbExplorer } = await import("../../../src/web/components/database/explorer/db-explorer-store");
const { TEMPLATE_SOURCE, gridExportForm } = await import("../../../src/web/components/database/impexp/impexp-state");
const { openExportOfCurrentDatabase, openImpExpTab, openImportIntoCurrentDatabase, openTreeImport } = await import("../../../src/web/components/database/impexp/open-impexp-tab");
const { useDbPaletteCommands } = await import("../../../src/web/components/layout/command-palette-db-commands");
const { createElement } = await import("react");
type MenuEntry = import("../../../src/web/components/database/explorer/explorer-menu").MenuEntry;
type TreeConnection = import("../../../src/web/components/database/explorer/explorer-model").TreeConnection;
type DbObject = import("../../../src/shared/db-structure").DbObject;

const server: TreeConnection = { id: 1, type: "postgres", name: "app-dev", group_name: null, color: null, readonly: 0, default_database: "shop", single_database: false };
const file: TreeConnection = { id: 2, type: "sqlite", name: "notes", group_name: null, color: null, readonly: 0 };
/** Not the connection's own database, so what is asked for names it. */
const reporting = { conn: 1, database: "reporting" };
const users: DbObject = { schema: "public", name: "users", kind: "table" };
const activeUsers: DbObject = { schema: "public", name: "active_users", kind: "view" };

let navigated = 0;
/** Both menus' actions; only `navigated`, `editsStructure` and `impExp` matter here. */
const desktop = {
  navigated: () => { navigated++; }, editsStructure: true, impExp: true,
  edit: () => {}, askDelete: () => {}, renameFolder: () => {}, deleteFolder: () => {}, failed: () => {},
};
const phone = { ...desktop, editsStructure: false, impExp: false };
const readonly = (c: TreeConnection): TreeConnection => ({ ...c, readonly: 1 });

const labels = (entries: MenuEntry[]) => entries.map((e) => (e.kind === "separator" ? "—" : "label" in e ? e.label : e.kind));
function select(entries: MenuEntry[], label: string): void {
  const entry = entries.find((e) => e.kind === "item" && e.label === label);
  if (entry?.kind !== "item") throw new Error(`No ${label} in ${labels(entries).join(", ")}`);
  entry.onSelect();
}
const asked = () => useStructureSave.getState().request;

const reportingPlace = {
  target: { kind: "connection", connectionId: 1, database: "reporting" }, connectionName: "app-dev", dbType: "postgres", connectionColor: null,
};

const setCurrent = (current: { conn: number; database: string | null } | null) =>
  useSettingsStore.setState((s) => ({ dbExplorerView: { ...s.dbExplorerView, current } }));

beforeEach(() => {
  navigated = 0;
  _resetDbExplorer();
  setCurrent(null);
  useStructureSave.setState({ request: null, seq: 0, rename: null });
  for (const t of [...useTabStore.getState().tabs]) useTabStore.getState().closeTab(t.id);
});

describe("a table's menu", () => {
  it("offers DBGate's structure commands on a desktop, in its order", () => {
    expect(labels(objectMenu(server, reporting, users, desktop))).toEqual([
      "Open data", "Open structure", "Show CREATE SQL", "New query", "—",
      "Drop table", "Rename table", "Truncate table", "Create table backup", "—",
      "Export advanced...", "Import", "—",
      "Copy name", "—", "Refresh structure",
    ]);
  });

  it("leaves them out on a phone, on a read-only connection, and for what is not a table", () => {
    const viewOnly = ["Open data", "Open structure", "Show CREATE SQL", "New query", "—", "Copy name", "—", "Refresh structure"];
    expect(labels(objectMenu(server, reporting, users, phone))).toEqual(viewOnly);
    // Read only, a table is still exported.
    expect(labels(objectMenu(readonly(server), reporting, users, desktop))).toEqual([...viewOnly.slice(0, 5), "Export advanced...", "—", ...viewOnly.slice(5)]);
    expect(labels(objectMenu(server, reporting, activeUsers, desktop))).not.toContain("Drop table");
  });

  it("asks Save changes for the drop, where the table is, and changes nothing itself", () => {
    select(objectMenu(server, reporting, users, desktop), "Drop table");
    expect(asked()).toEqual({ target: reportingPlace.target, place: reportingPlace, change: { kind: "drop-table", schema: "public", table: "users" } });
    expect(useStructureSave.getState().seq).toBe(1);
  });

  it("asks Save changes to truncate, and to back the table up under DBGate's dated name", () => {
    select(objectMenu(server, reporting, users, desktop), "Truncate table");
    expect(asked()?.change).toEqual({ kind: "truncate-table", schema: "public", table: "users" });
    select(objectMenu(server, reporting, users, desktop), "Create table backup");
    const change = asked()?.change;
    expect(change).toMatchObject({ kind: "backup-table", schema: "public", table: "users" });
    expect(change?.kind === "backup-table" && change.newName).toMatch(/^_users_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/);
    expect(useStructureSave.getState().seq).toBe(2);
  });

  it("asks for the new name first, and only then Save changes for the rename", () => {
    select(objectMenu(server, reporting, users, desktop), "Rename table");
    expect(asked()).toBeNull();
    const rename = useStructureSave.getState().rename!;
    expect(rename.value).toBe("users");
    rename.onConfirm("people");
    expect(asked()?.change).toEqual({ kind: "rename-table", schema: "public", table: "users", newName: "people" });
  });
});

describe("a column's menu", () => {
  it("offers Rename column and Drop column for a table's column, on a desktop that may write", () => {
    expect(labels(columnMenu(server, reporting, users, "email", desktop))).toEqual(["Rename column", "Drop column", "—", "Copy name"]);
    for (const menu of [
      columnMenu(server, reporting, users, "email", phone),
      columnMenu(readonly(server), reporting, users, "email", desktop),
      columnMenu(server, reporting, activeUsers, "email", desktop),
      columnMenu(server, reporting, undefined, "email", desktop),
    ]) expect(labels(menu)).toEqual(["Copy name"]);
  });

  it("asks Save changes to drop the column, and for a new name before renaming it", () => {
    select(columnMenu(server, reporting, users, "email", desktop), "Drop column");
    expect(asked()).toMatchObject({ place: reportingPlace, change: { kind: "drop-column", schema: "public", table: "users", column: "email" } });
    select(columnMenu(server, reporting, users, "email", desktop), "Rename column");
    const rename = useStructureSave.getState().rename!;
    expect(rename.value).toBe("email");
    rename.onConfirm("mail");
    expect(asked()?.change).toEqual({ kind: "rename-column", schema: "public", table: "users", column: "email", newName: "mail" });
  });
});

describe("New table", () => {
  it("leads the + menu on a desktop that may write, and is absent otherwise", () => {
    expect(labels(newObjectMenu(server, reporting, desktop))[0]).toBe("New table");
    expect(labels(newObjectMenu(server, reporting, phone))).not.toContain("New table");
    expect(labels(newObjectMenu(readonly(server), reporting, desktop))).not.toContain("New table");
  });

  it("opens a Structure tab of its own on a table not created yet, in the schema the tree shows", () => {
    select(newObjectMenu(server, reporting, desktop), "New table");
    expect(navigated).toBe(1);
    const tab = useTabStore.getState().tabs.find((t) => t.type === "db-structure")!;
    expect(tab.title).toBe("Table #1");
    expect(tab.metadata).toMatchObject({ connectionId: 1, database: "reporting", schemaName: "public", tableNumber: 1, tableEdit: { isNew: true } });
    expect(typeof tab.metadata?.newTableId).toBe("string");
    // Nothing is asked of the database until Save.
    expect(asked()).toBeNull();
  });

  it("is on a database's menu, and on a connection's only when the connection is one database", () => {
    expect(labels(databaseMenu(server, "reporting", false, desktop))).toEqual([
      "Switch to this database", "New query", "New table", "Export", "Import", "Refresh structure",
    ]);
    expect(labels(databaseMenu(server, "reporting", false, phone))).not.toContain("New table");
    expect(labels(databaseMenu(readonly(server), "reporting", false, desktop))).not.toContain("New table");

    expect(labels(connectionMenu(file, undefined, desktop)).slice(0, 3)).toEqual(["Connect", "New query", "New table"]);
    expect(labels(connectionMenu(file, undefined, phone))).not.toContain("New table");
    expect(labels(connectionMenu(readonly(file), undefined, desktop))).not.toContain("New table");
    // A server's tables are made in one of its databases.
    expect(labels(connectionMenu(server, undefined, desktop))).not.toContain("New table");
  });

  it("on a SQLite file has no schema to go in", () => {
    select(connectionMenu(file, undefined, desktop), "New table");
    const tab = useTabStore.getState().tabs.find((t) => t.type === "db-structure")!;
    expect(tab.metadata).toMatchObject({ connectionId: 2, schemaName: "" });
    expect(tab.metadata?.database).toBeUndefined();
  });
});

describe("Export and Import", () => {
  const impexpTabs = () => useTabStore.getState().tabs.filter((t) => t.type === "db-impexp");
  const lastForm = () => impexpTabs().at(-1)!.metadata?.impexp as Record<string, unknown>;
  const reportingTarget = { kind: "connection", connectionId: 1, database: "reporting" };

  it("exports a table or view from the tree as a Database source with that one row", () => {
    select(objectMenu(server, reporting, users, desktop), "Export advanced...");
    expect(impexpTabs()[0]!.title).toBe("reporting->CSV(1)");
    expect(lastForm()).toMatchObject({
      sourceType: "database", targetType: "csv", db: { target: reportingTarget, schema: "public" }, rows: [{ source: "users" }],
    });
    select(objectMenu(server, reporting, activeUsers, desktop), "Export advanced...");
    expect(lastForm()).toMatchObject({ rows: [{ source: "active_users" }] });
    // Each opening is a tab of its own, as in DBGate.
    expect(impexpTabs()).toHaveLength(2);
    expect(navigated).toBe(2);
  });

  it("imports into a table through the row the first file takes, and never into a view", () => {
    select(objectMenu(server, reporting, users, desktop), "Import");
    expect(impexpTabs()[0]!.title).toBe("CSV->reporting(1)");
    expect(lastForm()).toMatchObject({
      sourceType: "csv", targetType: "database", db: { target: reportingTarget, schema: "public" },
      rows: [{ source: TEMPLATE_SOURCE, target: "users" }],
    });
    expect(navigated).toBe(1);
    expect(labels(objectMenu(server, reporting, activeUsers, desktop))).not.toContain("Import");
  });

  it("exports only what has rows, and imports only into a table", () => {
    const of = (kind: DbObject["kind"]) => labels(objectMenu(server, reporting, { schema: "public", name: "x", kind }, desktop));
    expect(of("matview")).toContain("Export advanced...");
    expect(of("matview")).not.toContain("Import");
    for (const kind of ["function", "procedure", "trigger", "sequence"] as const) {
      expect(of(kind)).not.toContain("Export advanced...");
      expect(of(kind)).not.toContain("Import");
    }
  });

  it("exports and imports a database with no table chosen yet", () => {
    select(databaseMenu(server, "reporting", false, desktop), "Export");
    expect(lastForm()).toMatchObject({ sourceType: "database", db: { target: reportingTarget, schema: null }, rows: [] });
    expect(impexpTabs()[0]!.title).toBe("reporting->CSV(0)");
    select(databaseMenu(server, "reporting", false, desktop), "Import");
    expect(lastForm()).toMatchObject({ sourceType: "csv", targetType: "database", db: { target: reportingTarget }, rows: [] });
    expect(impexpTabs()[1]!.title).toBe("CSV->reporting(0)");
    expect(navigated).toBe(2);
  });

  it("offers Import on nothing read-only, and neither on a phone", () => {
    expect(labels(databaseMenu(readonly(server), "reporting", false, desktop))).toContain("Export");
    expect(labels(databaseMenu(readonly(server), "reporting", false, desktop))).not.toContain("Import");
    expect(labels(objectMenu(readonly(server), reporting, users, desktop))).not.toContain("Import");
    for (const menu of [databaseMenu(server, "reporting", false, phone), objectMenu(server, reporting, users, phone), connectionMenu(file, undefined, phone)]) {
      expect(labels(menu)).not.toContain("Export");
      expect(labels(menu)).not.toContain("Export advanced...");
      expect(labels(menu)).not.toContain("Import");
    }
    // Nor does asking for one by hand open anything.
    openTreeImport(readonly(server), reporting, users);
    expect(impexpTabs()).toHaveLength(0);
  });

  it("is on a connection's menu only when the connection is one database", () => {
    expect(labels(connectionMenu(file, undefined, desktop)).slice(0, 5)).toEqual(["Connect", "New query", "New table", "Export", "Import"]);
    expect(labels(connectionMenu(readonly(file), undefined, desktop))).not.toContain("Import");
    expect(labels(connectionMenu(server, undefined, desktop))).not.toContain("Export");
    select(connectionMenu(file, undefined, desktop), "Import");
    expect(lastForm()).toMatchObject({ db: { target: { kind: "connection", connectionId: 2 } } });
    expect((lastForm().db as { target: Record<string, unknown> }).target.database).toBeUndefined();
    expect(impexpTabs()[0]!.title).toBe("CSV->notes(0)");
    select(connectionMenu(file, undefined, desktop), "Export");
    expect(impexpTabs()[1]!.title).toBe("notes->CSV(0)");
  });

  it("puts a database file's tab with the file's project, and any other in every workspace", () => {
    openImpExpTab(gridExportForm({ target: { kind: "file", path: "/work/shop/app.db", projectName: "shop" }, schema: null }, "orders", "SELECT 1"), "app.db");
    select(databaseMenu(server, "reporting", false, desktop), "Export");
    expect(impexpTabs().map((t) => [t.title, t.projectId, t.closable])).toEqual([["Query->CSV(1)", "shop", true], ["reporting->CSV(0)", null, true]]);
  });

  it("from the palette, goes to the database the sidebar shows, and imports into none that is read-only", () => {
    openExportOfCurrentDatabase();
    openImportIntoCurrentDatabase();
    expect(impexpTabs().map((t) => t.title)).toEqual(["DB->CSV(0)", "CSV->DB(0)"]);
    expect(impexpTabs().map((t) => (t.metadata?.impexp as { db: { target: unknown } }).db.target)).toEqual([null, null]);

    useDbExplorer.setState({ connections: [server] as never });
    setCurrent(reporting);
    openExportOfCurrentDatabase();
    openImportIntoCurrentDatabase();
    expect(impexpTabs().slice(2).map((t) => [t.title, (t.metadata?.impexp as { db: { target: unknown } }).db.target])).toEqual([
      ["reporting->CSV(0)", reportingTarget], ["CSV->reporting(0)", reportingTarget],
    ]);

    useDbExplorer.setState({ connections: [readonly(server)] as never });
    openImportIntoCurrentDatabase();
    expect((lastForm().db as { target: unknown }).target).toBeNull();

    // A database the sidebar remembers on a connection not loaded yet: nothing to name, so none chosen.
    useDbExplorer.setState({ connections: [] as never });
    openExportOfCurrentDatabase();
    openImportIntoCurrentDatabase();
    expect(impexpTabs().slice(-2).map((t) => [t.title, (t.metadata?.impexp as { db: { target: unknown } }).db.target])).toEqual([
      ["DB->CSV(0)", null], ["CSV->DB(0)", null],
    ]);
  });

  /** What the palette offers, as it would render it. */
  async function paletteCommands(isMobile: boolean, onClose: () => void) {
    let items: ReturnType<typeof useDbPaletteCommands> = [];
    function Probe() {
      items = useDbPaletteCommands(isMobile, onClose);
      return null;
    }
    const mounted = await mount(createElement(Probe));
    await mounted.unmount();
    return items;
  }

  it("is in the palette on a desktop, and each closes it before opening its tab", async () => {
    let closed = 0;
    const items = await paletteCommands(false, () => { closed++; });
    const pick = (id: string) => items.find((i) => i.id === id)!;
    expect(items.map((i) => i.label)).toEqual(["Export database", "Import data"]);
    pick("db-export-database").action();
    pick("db-import-data").action();
    expect(closed).toBe(2);
    expect(impexpTabs().map((t) => t.title)).toEqual(["DB->CSV(0)", "CSV->DB(0)"]);
    expect(await paletteCommands(true, () => {})).toEqual([]);
  });
});
