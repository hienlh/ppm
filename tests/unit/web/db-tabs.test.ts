/**
 * Database tabs as data: where each one talks to, the id it goes by — so a table's data, its
 * structure and one object's SQL each land on one tab however they were opened — the id read back
 * out of a URL, the Query tab's unsaved dot and number, and tabs saved by an older version as they
 * open now.
 */
import { describe, expect, it } from "bun:test";
import {
  dbTabId, dbTabMetadataFromId, isQueryTabDirty, nextQueryNumber, queryTabMetadata, targetLabel, targetOf, targetUrl,
  upgradeDbTab,
} from "../../../src/web/lib/db-tabs.ts";
import { upgradePanelTabs, type Panel } from "../../../src/web/stores/panel-utils.ts";
import type { Tab } from "../../../src/web/stores/tab-store.ts";
import { FILE_CONNECTION_ID } from "../../../src/services/database/file-database.ts";

describe("where a tab talks to", () => {
  it("is a saved connection, one of its server's databases, or a file", () => {
    expect(targetOf({ connectionId: 5 })).toEqual({ kind: "connection", connectionId: 5 });
    expect(targetOf({ connectionId: "5", database: "reporting" })).toEqual({ kind: "connection", connectionId: 5, database: "reporting" });
    expect(targetOf({ connectionId: 5, database: "" })).toEqual({ kind: "connection", connectionId: 5 });
    expect(targetOf({ dbFile: { path: "data/app.db", projectName: "shop" } })).toEqual({ kind: "file", path: "data/app.db", projectName: "shop" });
    expect(targetOf({ dbFile: { path: "/tmp/a.db" } })).toEqual({ kind: "file", path: "/tmp/a.db" });
  });

  it("is nothing for metadata naming no connection or no file", () => {
    for (const m of [undefined, {}, { connectionId: 0 }, { connectionId: -1 }, { connectionId: 1.5 }, { connectionId: "5x" }, { dbFile: { path: "" } }, { dbFile: "a.db" }]) {
      expect(targetOf(m as Record<string, unknown> | undefined)).toBeNull();
    }
  });

  it("is the file when a tab names both", () => {
    expect(targetOf({ connectionId: 5, dbFile: { path: "a.db" } })).toEqual({ kind: "file", path: "a.db" });
  });

  it("builds the request under the connection's id, a file's under the id the server serves files under", () => {
    expect(targetUrl({ kind: "connection", connectionId: 5 }, "/tables")).toBe("/api/db/connections/5/tables");
    expect(targetUrl({ kind: "connection", connectionId: 5, database: "my db" }, "/tables")).toBe("/api/db/connections/5/tables?database=my%20db");
    expect(targetUrl({ kind: "file", path: "/tmp/a b.db" }, "/objects")).toBe("/api/db/connections/file/objects?path=%2Ftmp%2Fa%20b.db");
    expect(targetUrl({ kind: "file", path: "data/app.db", projectName: "shop & co" }, "/objects"))
      .toBe("/api/db/connections/file/objects?path=data%2Fapp.db&project=shop%20%26%20co");
    expect(targetUrl({ kind: "file", path: "x.db" }).startsWith(`/api/db/connections/${FILE_CONNECTION_ID}?`)).toBe(true);
  });

  it("joins its own parameters onto a path that already has a query string", () => {
    expect(targetUrl({ kind: "connection", connectionId: 5, database: "r" }, "/structure?table=t"))
      .toBe("/api/db/connections/5/structure?table=t&database=r");
    expect(targetUrl({ kind: "file", path: "a.db" }, "/structure?table=t")).toBe("/api/db/connections/file/structure?table=t&path=a.db");
    expect(targetUrl({ kind: "connection", connectionId: 5 }, "/structure?table=t")).toBe("/api/db/connections/5/structure?table=t");
  });

  it("is labelled by the connection, the database when it is not the connection's own, or the file's name", () => {
    expect(targetLabel({ kind: "connection", connectionId: 5 }, "shop")).toBe("shop");
    expect(targetLabel({ kind: "connection", connectionId: 5, database: "reporting" }, "shop")).toBe("shop/reporting");
    expect(targetLabel({ kind: "file", path: "/home/u/data/app.db" }, "ignored")).toBe("app.db");
    expect(targetLabel({ kind: "file", path: "C:\\data\\app.db" }, undefined)).toBe("app.db");
    expect(targetLabel(null, undefined)).toBe("Database");
  });
});

describe("a tab's id", () => {
  const users = { connectionId: 5, schemaName: "public", tableName: "users" };

  it("is one per table's data and one per table's structure", () => {
    expect(dbTabId("database", users)).toBe("database:5::public:users");
    expect(dbTabId("db-structure", users)).toBe("db-structure:5::public:users");
    expect(dbTabId("database", { ...users, database: "reporting" })).toBe("database:5:reporting:public:users");
  });

  it("names a file by its project and path", () => {
    expect(dbTabId("database", { dbFile: { path: "data/app.db", projectName: "shop" }, schemaName: "", tableName: "users" }))
      .toBe("database:file:shop:data%2Fapp.db::users");
    expect(dbTabId("database", { dbFile: { path: "/tmp/a.db" }, schemaName: "", tableName: "users" }))
      .not.toBe(dbTabId("database", { dbFile: { path: "/tmp/b.db" }, schemaName: "", tableName: "users" }));
  });

  it("gives a table, a view and a materialized view of one name one SQL tab: they share a namespace", () => {
    const sql = (objectKind: string) => dbTabId("db-sql", { connectionId: 5, schemaName: "public", objectKind, objectName: "t" });
    expect(sql("view")).toBe(sql("table"));
    expect(sql("matview")).toBe(sql("table"));
    expect(sql("function")).not.toBe(sql("table"));
  });

  it("tells a routine's overloads apart by their arguments, and a trigger by its table", () => {
    const fn = (objectArgs: string) => dbTabId("db-sql", { connectionId: 5, schemaName: "public", objectKind: "function", objectName: "f", objectArgs });
    expect(fn("integer")).not.toBe(fn("text"));
    expect(fn("")).not.toBe(fn("integer"));
    const trigger = (objectTable: string) => dbTabId("db-sql", { connectionId: 5, schemaName: "main", objectKind: "trigger", objectName: "t", objectTable });
    expect(trigger("orders")).not.toBe(trigger("users"));
  });

  it("gives a table's data opened with an instance a tab of its own: the row a foreign key refers to", () => {
    expect(dbTabId("database", { ...users, instance: "r1" })).toBe("database:5::public:users:r1");
    expect(dbTabId("database", { ...users, instance: "r1" })).not.toBe(dbTabId("database", { ...users, instance: "r2" }));
    expect(dbTabId("database", { ...users, instance: "" })).toBe(dbTabId("database", users));
    expect(dbTabId("database", { ...users, instance: 7 })).toBe(dbTabId("database", users));
    // Only a table's data: its structure stays one tab.
    expect(dbTabId("db-structure", { ...users, instance: "r1" })).toBe(dbTabId("db-structure", users));
  });

  it("gives every query tab its own, whatever it runs against", () => {
    expect(dbTabId("db-query", { connectionId: 5, queryId: "q1" })).toBe("db-query:q1");
    expect(dbTabId("db-query", { connectionId: 6, queryId: "q1" })).toBe("db-query:q1");
    expect(dbTabId("db-query", { connectionId: 5 })).not.toBe(dbTabId("db-query", { connectionId: 5 }));
  });
});

describe("an id read back out of a URL", () => {
  const back = (type: "database" | "db-structure" | "db-sql", m: Record<string, unknown>) =>
    dbTabMetadataFromId(type, dbTabId(type, m).slice(type.length + 1));

  it("names the same table, even with the separator and escapes in its names", () => {
    const m = { connectionId: 5, database: "re:po%rt", schemaName: "a:b", tableName: "c/d%20" };
    expect(back("database", m)).toEqual(m);
    expect(back("db-structure", m)).toEqual(m);
  });

  it("names the same tab of a referenced row, by its instance", () => {
    const m = { connectionId: 5, schemaName: "public", tableName: "users", instance: "a:b" };
    expect(back("database", m)).toEqual(m);
    // A structure tab's id has no instance, so none comes back.
    expect(dbTabMetadataFromId("db-structure", "5::public:users:r1")).toEqual({ connectionId: 5, schemaName: "public", tableName: "users" });
  });

  it("names the same file", () => {
    const m = { dbFile: { path: "data/a:b.db", projectName: "shop" }, schemaName: "", tableName: "users" };
    expect(back("database", m)).toEqual(m);
    expect(back("database", { dbFile: { path: "/tmp/a.db" }, schemaName: "", tableName: "t" }))
      .toEqual({ dbFile: { path: "/tmp/a.db" }, schemaName: "", tableName: "t" });
  });

  it("names the same object for a SQL tab, a routine's empty argument list included", () => {
    const fn = { connectionId: 5, schemaName: "public", objectKind: "function", objectName: "f", objectArgs: "" };
    expect(back("db-sql", fn)).toEqual(fn);
    const trigger = { connectionId: 5, schemaName: "main", objectKind: "trigger", objectName: "t", objectTable: "orders" };
    expect(back("db-sql", trigger)).toEqual(trigger);
    // A table has no arguments to carry, so none come back.
    expect(back("db-sql", { connectionId: 5, schemaName: "public", objectKind: "table", objectName: "users" }))
      .toEqual({ connectionId: 5, schemaName: "public", objectKind: "table", objectName: "users" });
  });

  it("is nothing for one naming nothing that can be opened", () => {
    expect(dbTabMetadataFromId("database", "5::public:")).toBeNull();
    expect(dbTabMetadataFromId("database", "x::public:users")).toBeNull();
    expect(dbTabMetadataFromId("database", "0::public:users")).toBeNull();
    expect(dbTabMetadataFromId("database", "5::public:%E0%A4%A")).toBeNull();
    expect(dbTabMetadataFromId("database", "file:shop::users")).toBeNull();
    expect(dbTabMetadataFromId("db-sql", "5::public:index:users_pkey::")).toBeNull();
    expect(dbTabMetadataFromId("db-sql", "5::public:table:::")).toBeNull();
    expect(dbTabMetadataFromId("db-query", "q1")).toBeNull();
  });
});

describe("a query tab", () => {
  it("opens holding its SQL, clean, and runs it only when asked", () => {
    const m = queryTabMetadata("SELECT 1", 3);
    expect(m).toMatchObject({ queryNumber: 3, currentSql: "SELECT 1", openedSql: "SELECT 1" });
    expect(m.runOnOpen).toBeUndefined();
    expect(typeof m.queryId === "string" && m.queryId.length > 0).toBe(true);
    expect(queryTabMetadata("SELECT 1", 3, { run: true }).runOnOpen).toBe(true);
    expect(queryTabMetadata("", 1).queryId).not.toBe(queryTabMetadata("", 1).queryId);
    expect(isQueryTabDirty(m)).toBe(false);
  });

  it("carries the unsaved dot once its SQL differs from what it opened with", () => {
    const m = queryTabMetadata("SELECT 1", 1);
    expect(isQueryTabDirty({ ...m, currentSql: "SELECT 2" })).toBe(true);
    expect(isQueryTabDirty({ ...m, currentSql: "SELECT 1" })).toBe(false);
    expect(isQueryTabDirty({ currentSql: "SELECT 1" })).toBe(true);
    expect(isQueryTabDirty({ currentSql: "" })).toBe(false);
    expect(isQueryTabDirty({ openedSql: "SELECT 1" })).toBe(false);
    expect(isQueryTabDirty(undefined)).toBe(false);
  });

  it("is numbered one past the highest query tab open", () => {
    expect(nextQueryNumber([])).toBe(1);
    // The highest first: the tab list is in panel order, not the order the queries were opened in.
    expect(nextQueryNumber([
      { type: "db-query", metadata: { queryNumber: 7 } },
      { type: "db-query", metadata: { queryNumber: 2 } },
      { type: "database", metadata: { queryNumber: 99 } },
      { type: "db-query", metadata: { queryNumber: "9" } },
      { type: "db-query" },
    ])).toBe(8);
  });
});

describe("a tab saved by an older version", () => {
  const stored = (id: string, type: string, metadata: Record<string, unknown>) => ({ id, type, metadata });

  it("becomes a clean Query tab holding its SQL when it was a query, where it was and in its panel", () => {
    const next = upgradeDbTab(stored("database:5::query:q1@p2", "database", {
      connectionId: 5, connectionName: "shop", connectionColor: "#f00", dbType: "postgres", database: "reporting",
      queryId: "q1", queryNumber: 4, initialSql: "SELECT 1", tableName: "",
    }))!;
    expect(next.type).toBe("db-query");
    expect(next.id).toBe("db-query:q1@p2");
    expect(next.metadata).toEqual({
      connectionName: "shop", dbType: "postgres", connectionColor: "#f00", database: "reporting", connectionId: 5,
      queryId: "q1", queryNumber: 4, currentSql: "SELECT 1", openedSql: "SELECT 1",
    });
    expect(isQueryTabDirty(next.metadata)).toBe(false);
  });

  it("keeps what was typed over what it opened with, and gets an id of its own when it had none", () => {
    const next = upgradeDbTab(stored("tab-1", "database", { connectionId: 5, initialSql: "SELECT 1", currentSql: "SELECT 2" }))!;
    expect(next.metadata!.currentSql).toBe("SELECT 2");
    expect(next.metadata!.openedSql).toBe("SELECT 2");
    expect(next.id).toBe(`db-query:${next.metadata!.queryId as string}`);
    expect((next.metadata!.queryId as string).length).toBeGreaterThan(0);
  });

  it("names a table tab's connection by its number, as a URL left it a string", () => {
    const next = upgradeDbTab(stored("database:5::public:users", "database", { connectionId: "5", schemaName: "public", tableName: "users" }))!;
    expect(next.metadata!.connectionId).toBe(5);
    expect(next.id).toBe("database:5::public:users");
    const current = stored("database:5::public:users", "database", { connectionId: 5, schemaName: "public", tableName: "users" });
    expect(upgradeDbTab(current)).toBe(current);
  });

  it("turns the old Postgres and SQLite viewers' tabs on a saved connection into the new ones", () => {
    expect(upgradeDbTab(stored("postgres:x", "postgres", { connectionId: 3, connectionName: "pg", schemaName: "sales", tableName: "orders" })))
      .toEqual({
        id: "database:3::sales:orders", type: "database",
        metadata: { connectionName: "pg", connectionId: 3, dbType: "postgres", schemaName: "sales", tableName: "orders" },
      });
    const sqlite = upgradeDbTab(stored("sqlite:y", "sqlite", { connectionId: 4, tableName: "t" }))!;
    expect(sqlite.type).toBe("database");
    expect(sqlite.metadata).toMatchObject({ connectionId: 4, dbType: "sqlite", schemaName: "", tableName: "t" });
    const query = upgradeDbTab(stored("postgres:z", "postgres", { connectionId: 3, currentSql: "SELECT 3" }))!;
    expect(query.type).toBe("db-query");
    expect(query.metadata).toMatchObject({ connectionId: 3, dbType: "postgres", currentSql: "SELECT 3", openedSql: "SELECT 3" });
  });

  it("drops what cannot be opened any more, and leaves a file's own tab and every other tab alone", () => {
    expect(upgradeDbTab(stored("postgres:x", "postgres", { connectionString: "postgres://…", tableName: "t" }))).toBeNull();
    expect(upgradeDbTab(stored("sqlite:x", "sqlite", {}))).toBeNull();
    const file = stored("sqlite:a.db", "sqlite", { filePath: "a.db", projectName: "shop" });
    expect(upgradeDbTab(file)).toBe(file);
    const editor = stored("editor:a.ts", "editor", { filePath: "a.ts" });
    expect(upgradeDbTab(editor)).toBe(editor);
  });
});

describe("a panel's tabs, upgraded", () => {
  const tab = (id: string, type: string, metadata: Record<string, unknown>): Tab =>
    ({ id, type, title: id, projectId: null, closable: true, metadata } as Tab);
  const panel = (tabs: Tab[], activeTabId: string | null, tabHistory: string[]): Panel => ({ id: "p1", tabs, activeTabId, tabHistory });

  it("keep the first of two that land on one id, and follow the active tab and the history to the new ids", () => {
    const before = panel([
      tab("postgres:old", "postgres", { connectionId: 3, schemaName: "", tableName: "orders" }),
      tab("database:3:::orders", "database", { connectionId: 3, schemaName: "", tableName: "orders" }),
      tab("editor:a.ts", "editor", { filePath: "a.ts" }),
    ], "postgres:old", ["editor:a.ts", "postgres:old"]);
    const after = upgradePanelTabs(before);
    expect(after.tabs.map((t) => t.id)).toEqual(["database:3:::orders", "editor:a.ts"]);
    expect(after.activeTabId).toBe("database:3:::orders");
    expect(after.tabHistory).toEqual(["editor:a.ts", "database:3:::orders"]);
  });

  it("move the focus to the last tab used when the active one is dropped", () => {
    const after = upgradePanelTabs(panel([
      tab("editor:a.ts", "editor", { filePath: "a.ts" }),
      tab("postgres:gone", "postgres", { tableName: "t" }),
    ], "postgres:gone", ["editor:a.ts", "postgres:gone"]));
    expect(after.tabs.map((t) => t.id)).toEqual(["editor:a.ts"]);
    expect(after.activeTabId).toBe("editor:a.ts");
    expect(after.tabHistory).toEqual(["editor:a.ts"]);
  });

  it("fall back to the last tab used when the active id names no tab at all", () => {
    const after = upgradePanelTabs(panel([
      tab("postgres:old", "postgres", { connectionId: 3, schemaName: "", tableName: "orders" }),
      tab("editor:a.ts", "editor", { filePath: "a.ts" }),
    ], "ghost", ["postgres:old", "editor:a.ts"]));
    expect(after.activeTabId).toBe("editor:a.ts");
  });

  it("leave a panel with nothing to upgrade as it was", () => {
    const current = panel([tab("database:5::public:users", "database", { connectionId: 5, schemaName: "public", tableName: "users" })], "database:5::public:users", []);
    expect(upgradePanelTabs(current)).toBe(current);
  });
});
