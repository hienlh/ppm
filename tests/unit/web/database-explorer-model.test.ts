/**
 * The Database sidebar's tree as data: current against focused database, the `database` a request
 * and a tab carry, how connections and objects are searched, grouped and sorted.
 */
import { describe, expect, it } from "bun:test";
import {
  columnsByTable, connectionShownBelow, connectionWhere, databaseParam, focusDiffers, folderNames, formatRowEstimate, groupObjects, highlightParts,
  initialSchema, matchConnection, matchingColumns, schemaOptions, searchNeedsColumns, singleDbRef, tabDatabase, tabDbRef,
  visibleDatabases, type DbRef, type ObjectFilter, type TreeConnection,
} from "../../../src/web/components/database/explorer/explorer-model";
import type { DbObjectList } from "../../../src/shared/db-structure";

const conn = (over: Partial<TreeConnection> & { id: number }): TreeConnection => ({
  type: "postgres", name: `c${over.id}`, group_name: null, color: null, readonly: 1, ...over,
});

const server = conn({ id: 1, name: "app-dev", default_database: "shop", single_database: false, server: "db.local:5432", user: "app" });
const single = conn({ id: 2, name: "shop-only", default_database: "shop", single_database: true, server: "db.local", user: "app" });
const bare = conn({ id: 3, name: "bare", default_database: null, single_database: false, server: "db.local" });
const file = conn({ id: 4, type: "sqlite", name: "notes", single_database: true, server: "/home/me/data/notes.db" });
const byId = (id: number) => [server, single, bare, file].find((c) => c.id === id);

describe("current and focused database", () => {
  it("makes one database of a SQLite file and of a server connection that uses only its default", () => {
    expect(singleDbRef(file)).toEqual({ conn: 4, database: null });
    expect(singleDbRef(single)).toEqual({ conn: 2, database: "shop" });
    expect(singleDbRef(server)).toBeNull();
  });

  it("asks only when the focused row is another connection or another database of it", () => {
    const shop: DbRef = { conn: 1, database: "shop" };
    expect(focusDiffers(null, shop, () => true)).toBe(false);
    expect(focusDiffers(shop, shop, () => true)).toBe(false);
    expect(focusDiffers({ conn: 1, database: "reporting" }, shop, () => true)).toBe(true);
    // The server's own row keeps whichever of its databases is current.
    expect(focusDiffers({ conn: 1, database: null }, shop, () => true)).toBe(false);
    expect(focusDiffers({ conn: 4, database: null }, shop, () => true)).toBe(true);
    expect(focusDiffers({ conn: 4, database: null }, null, () => true)).toBe(true);
    // A focus on a deleted connection is no question.
    expect(focusDiffers({ conn: 9, database: null }, shop, (id) => id !== 9)).toBe(false);
  });

  it("names the connection whose failure the object list shows: the one it asks about, else the current one", () => {
    const shop: DbRef = { conn: 1, database: "shop" };
    expect(connectionShownBelow(null, shop, () => true)).toBe(1);
    expect(connectionShownBelow({ conn: 4, database: null }, shop, () => true)).toBe(4);
    expect(connectionShownBelow({ conn: 4, database: null }, null, () => true)).toBe(4);
    // Picking the current connection's own row asks nothing, so the list still shows the current one.
    expect(connectionShownBelow({ conn: 1, database: null }, shop, () => true)).toBe(1);
    expect(connectionShownBelow(null, null, () => true)).toBeNull();
    // A deleted connection is shown nowhere.
    expect(connectionShownBelow(null, { conn: 9, database: null }, (id) => id !== 9)).toBeNull();
  });

  it("follows a tab to its database, the connection's own when it names none", () => {
    expect(tabDbRef({ type: "database", metadata: { connectionId: 1, tableName: "users" } }, byId)).toEqual({ conn: 1, database: "shop" });
    expect(tabDbRef({ type: "database", metadata: { connectionId: 1, database: "reporting" } }, byId)).toEqual({ conn: 1, database: "reporting" });
    expect(tabDbRef({ type: "database", metadata: { connectionId: 4, database: "ignored" } }, byId)).toEqual({ conn: 4, database: null });
    expect(tabDbRef({ type: "database", metadata: { connectionId: 3 } }, byId)).toEqual({ conn: 3, database: null });
    expect(tabDbRef({ type: "terminal", metadata: { connectionId: 1 } }, byId)).toBeNull();
    expect(tabDbRef({ type: "database", metadata: { connectionId: 99 } }, byId)).toBeNull();
    expect(tabDbRef(null, byId)).toBeNull();
  });

  it("sends ?database= for every server database it names, and records it on a tab only when it is not the own", () => {
    expect(databaseParam({ conn: 1, database: "shop" }, server)).toBe("shop");
    expect(databaseParam({ conn: 1, database: "reporting" }, server)).toBe("reporting");
    expect(databaseParam({ conn: 3, database: null }, bare)).toBeUndefined();
    expect(databaseParam({ conn: 4, database: null }, file)).toBeUndefined();
    expect(tabDatabase({ conn: 1, database: "shop" }, server)).toBeUndefined();
    expect(tabDatabase({ conn: 1, database: "reporting" }, server)).toBe("reporting");
    expect(tabDatabase({ conn: 4, database: null }, file)).toBeUndefined();
  });
});

describe("the connection list", () => {
  it("hides the databases the Advanced tab filters out", () => {
    const filtered = { ...server, allowed_databases_regex: "^shop" };
    expect(visibleDatabases(filtered, ["postgres", "shop", "shop_test", "reporting"])).toEqual(["shop", "shop_test"]);
    expect(visibleDatabases({ ...server, allowed_databases: ["Reporting"] }, ["shop", "reporting"])).toEqual(["reporting"]);
  });

  it("searches the fields asked for, and lists only the matching databases of a server it did not match", () => {
    const dbs = ["postgres", "shop", "reporting"];
    expect(matchConnection(server, "", ["name"], dbs)).toEqual({ show: true, databases: null });
    expect(matchConnection(server, "APP", ["name"], dbs)).toEqual({ show: true, databases: null });
    expect(matchConnection(server, "report", ["name", "database"], dbs)).toEqual({ show: true, databases: ["reporting"] });
    expect(matchConnection(server, "report", ["name"], dbs).show).toBe(false);
    expect(matchConnection(server, "report", ["database"], undefined).show).toBe(false);
    expect(matchConnection(server, "5432", ["server"], dbs).show).toBe(true);
    expect(matchConnection(server, "5432", ["name"], dbs).show).toBe(false);
    expect(matchConnection(server, "app", ["user"], dbs).show).toBe(true);
    expect(matchConnection(server, "postgre", ["engine"], dbs).show).toBe(true);
    expect(matchConnection(single, "shop", ["database"], undefined)).toEqual({ show: true, databases: null });
    expect(matchConnection(file, "notes.db", ["database"], undefined).show).toBe(true);
    expect(matchConnection(file, "home", ["database"], undefined).show).toBe(false);
  });

  it("puts folders in name order, empty ones included", () => {
    const conns = [conn({ id: 5, group_name: "Prod" }), conn({ id: 6, group_name: "Local" }), conn({ id: 7, group_name: "Local" })];
    expect(folderNames(conns, ["Archive", "Prod"])).toEqual(["Archive", "Local", "Prod"]);
  });

  it("describes where a connection goes", () => {
    expect(connectionWhere(server)).toBe("app@db.local:5432/shop");
    expect(connectionWhere(bare)).toBe("db.local");
    expect(connectionWhere(file)).toBe("/home/me/data/notes.db");
  });
});

const LIST: DbObjectList = {
  schemas: ["audit", "public", "empty"],
  objects: [
    { schema: "public", name: "users", kind: "table", rowEstimate: 5231 },
    { schema: "public", name: "orders", kind: "table", rowEstimate: 0 },
    { schema: "public", name: "Addresses", kind: "table" },
    { schema: "public", name: "active_users", kind: "view" },
    { schema: "public", name: "totals", kind: "matview", rowEstimate: 12 },
    { schema: "public", name: "add", kind: "function", args: "a text, b text" },
    { schema: "public", name: "add", kind: "function", args: "a integer, b integer" },
    { schema: "public", name: "reset", kind: "procedure", args: "" },
    { schema: "public", name: "users_touch", kind: "trigger", table: "users" },
    { schema: "public", name: "users_id_seq", kind: "sequence" },
    { schema: "audit", name: "log", kind: "table", rowEstimate: 90 },
  ],
};

const filter = (over: Partial<ObjectFilter> = {}): ObjectFilter => ({ query: "", fields: ["name"], onlyWithRows: false, sort: "name", ...over });
const names = (groups: ReturnType<typeof groupObjects>) => Object.fromEntries(groups.map((g) => [g.label, g.items.map((o) => o.name)]));

describe("the object list", () => {
  it("groups a schema's objects in DBGate's order and leaves empty groups out", () => {
    expect(names(groupObjects(LIST, "public", filter()))).toEqual({
      Tables: ["Addresses", "orders", "users"],
      Views: ["active_users"],
      "Materialized views": ["totals"],
      Procedures: ["reset"],
      Functions: ["add", "add"],
      Triggers: ["users_touch"],
      Sequences: ["users_id_seq"],
    });
    expect(names(groupObjects(LIST, "audit", filter()))).toEqual({ Tables: ["log"] });
    expect(groupObjects(LIST, null, filter())[0]!.items).toHaveLength(4);
  });

  it("tells overloads apart in name order", () => {
    const fns = groupObjects(LIST, "public", filter()).find((g) => g.kind === "function")!;
    expect(fns.items.map((o) => o.args)).toEqual(["a integer, b integer", "a text, b text"]);
  });

  it("sorts by the row estimate, and hides only tables it knows are empty", () => {
    const tables = (f: ObjectFilter) => groupObjects(LIST, "public", f).find((g) => g.kind === "table")!.items.map((o) => o.name);
    expect(tables(filter({ sort: "rows" }))).toEqual(["users", "orders", "Addresses"]);
    expect(tables(filter({ onlyWithRows: true }))).toEqual(["Addresses", "users"]);
  });

  it("searches by name, schema, column name and column type", () => {
    const columns = columnsByTable([
      { schema: "public", table: "orders", name: "total", type: "numeric(10,2)" },
      { schema: "public", table: "users", name: "email", type: "text" },
    ]);
    expect(names(groupObjects(LIST, "public", filter({ query: "USER" })))).toEqual({
      Tables: ["users"], Views: ["active_users"], Triggers: ["users_touch"], Sequences: ["users_id_seq"],
    });
    expect(names(groupObjects(LIST, "audit", filter({ query: "aud", fields: ["schema"] })))).toEqual({ Tables: ["log"] });
    expect(names(groupObjects(LIST, "public", filter({ query: "tota", fields: ["column"], columns })))).toEqual({ Tables: ["orders"] });
    expect(names(groupObjects(LIST, "public", filter({ query: "numeric", fields: ["type"], columns })))).toEqual({ Tables: ["orders"] });
    expect(groupObjects(LIST, "public", filter({ query: "zzz" }))).toEqual([]);
    expect(matchingColumns(LIST.objects[1]!, filter({ query: "tot", fields: ["column"], columns })).map((c) => c.name)).toEqual(["total"]);
    expect(searchNeedsColumns({ query: "x", fields: ["name", "type"] })).toBe(true);
    expect(searchNeedsColumns({ query: " ", fields: ["column"] })).toBe(false);
    expect(searchNeedsColumns({ query: "x", fields: ["name", "schema"] })).toBe(false);
  });

  it("offers every schema with its count, and opens on the remembered one, then public", () => {
    const options = schemaOptions(LIST);
    expect(options).toEqual([{ schema: "audit", count: 1 }, { schema: "empty", count: 0 }, { schema: "public", count: 10 }]);
    expect(initialSchema(options, "audit")).toBe("audit");
    expect(initialSchema(options, "gone")).toBe("public");
    expect(initialSchema([{ schema: "a", count: 0 }, { schema: "b", count: 2 }], undefined)).toBe("b");
    expect(initialSchema([], undefined)).toBeNull();
  });
});

describe("formatting", () => {
  it("shortens row estimates the way DBGate does", () => {
    expect([0, 42, 100, 5231, 12_400, 1_340_000].map(formatRowEstimate)).toEqual(["0", "42", "~100", "~5.2k", "~12k", "~1.3M"]);
  });

  it("cuts text around the first match, whatever its case", () => {
    expect(highlightParts("active_Users", "user")).toEqual(["active_", "User", "s"]);
    expect(highlightParts("orders", "x")).toBeNull();
    expect(highlightParts("orders", "  ")).toBeNull();
  });
});
