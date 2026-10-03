/**
 * A table tab is keyed as DBGate keys it — connection, database, schema, table — so one table
 * opened from the tree, the command palette or a foreign key lands on one tab, and the same table
 * in two databases of a server gets two. Tabs saved under the old key are moved onto the new one.
 */
import { describe, expect, it } from "bun:test";
import { deriveTabId, migrateTabIds, type PanelLayout } from "../../../src/web/stores/panel-utils.ts";
import type { Tab } from "../../../src/web/stores/tab-store.ts";

const tab = (id: string, metadata: Record<string, unknown>): Tab => ({
  id, type: "database", title: "t", projectId: null, closable: true, metadata,
});

describe("a database tab's id", () => {
  it("names the connection, the database, the schema and the table", () => {
    expect(deriveTabId("database", { connectionId: 5, schemaName: "public", tableName: "users" })).toBe("database:5::public:users");
    expect(deriveTabId("database", { connectionId: 5, database: "reporting", schemaName: "public", tableName: "users" }))
      .toBe("database:5:reporting:public:users");
  });

  it("tells apart the same table in two schemas and in two databases", () => {
    const ids = new Set([
      deriveTabId("database", { connectionId: 5, schemaName: "public", tableName: "users" }),
      deriveTabId("database", { connectionId: 5, schemaName: "audit", tableName: "users" }),
      deriveTabId("database", { connectionId: 5, database: "reporting", schemaName: "public", tableName: "users" }),
    ]);
    expect(ids.size).toBe(3);
  });

  it("cannot be forged into another table's id by a name holding the separator", () => {
    const a = deriveTabId("database", { connectionId: 5, schemaName: "a:b", tableName: "c" });
    const b = deriveTabId("database", { connectionId: 5, schemaName: "a", tableName: "b:c" });
    expect(a).not.toBe(b);
  });

  it("gives a query tab an id of its own, whatever it runs against", () => {
    expect(deriveTabId("db-query", { connectionId: 5, queryId: "q1", currentSql: "SELECT 1" })).toBe("db-query:q1");
    expect(deriveTabId("db-query", { connectionId: 5, queryId: "q2" })).not.toBe(deriveTabId("db-query", { connectionId: 5, queryId: "q1" }));
    // Its connection box can move it, so the target is not part of what names it.
    expect(deriveTabId("db-query", { connectionId: 7, queryId: "q1" })).toBe("db-query:q1");
  });
});

describe("tabs saved under the old key", () => {
  const layout = (tabs: Tab[], activeTabId: string): PanelLayout => ({
    panels: { p1: { id: "p1", tabs, activeTabId, tabHistory: tabs.map((t) => t.id) } },
    grid: [["p1"]],
    focusedPanelId: "p1",
  });

  it("move onto the new one, the active tab and the history with them", () => {
    const before = layout([
      tab("database:5:users", { connectionId: 5, schemaName: "public", tableName: "users" }),
      tab("database:5:orders@p2", { connectionId: 5, schemaName: "public", tableName: "orders" }),
    ], "database:5:users");
    const after = migrateTabIds(before).panels.p1!;
    expect(after.tabs.map((t) => t.id)).toEqual(["database:5::public:users", "database:5::public:orders@p2"]);
    expect(after.activeTabId).toBe("database:5::public:users");
    expect(after.tabHistory).toEqual(["database:5::public:users", "database:5::public:orders@p2"]);
  });

  it("are left alone once they carry it", () => {
    const current = layout([tab("database:5::public:users", { connectionId: 5, schemaName: "public", tableName: "users" })], "database:5::public:users");
    const after = migrateTabIds(current).panels.p1!;
    expect(after.tabs[0]!.id).toBe("database:5::public:users");
    expect(after.tabs[0]).toBe(current.panels.p1!.tabs[0]!);
  });
});
