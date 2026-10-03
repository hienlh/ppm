/**
 * The Tables, views, functions section as rows: a group per kind, its objects while open, a table's
 * columns while expanded — by hand, or by a search that matched one of them — and a long group cut
 * at a page with a "Show more" row. Also the SQL the section's menus put in a new query tab.
 */
import { describe, expect, it } from "bun:test";
import {
  GROUP_PAGE, objectRowKey, objectTreeRows, structureColumns, structuresToRead, type ObjectTreeInput, type ObjectTreeRow,
} from "../../../src/web/components/database/object-tree/object-tree-model";
import {
  callTemplate, createRoutineTemplate, createTriggerTemplate, createViewTemplate, qualifiedName, routineTemplateKind, selectTemplate,
} from "../../../src/web/components/database/explorer/sql-templates";
import { columnsByTable, objectNodeKey, type DbRef, type ObjectFilter } from "../../../src/web/components/database/explorer/explorer-model";
import type { DbObject, DbObjectList, DbTableStructure } from "../../../src/shared/db-structure";

const ref: DbRef = { conn: 1, database: "shop" };

const list: DbObjectList = {
  schemas: ["audit", "public"],
  objects: [
    { schema: "public", name: "users", kind: "table", rowEstimate: 5231 },
    { schema: "public", name: "orders", kind: "table", rowEstimate: 0 },
    { schema: "public", name: "active_users", kind: "view" },
    { schema: "public", name: "total", kind: "function", args: "integer" },
    { schema: "public", name: "total", kind: "function", args: "integer, integer" },
    { schema: "public", name: "stamp", kind: "function", args: "" },
    { schema: "public", name: "users_audit", kind: "trigger", table: "users" },
    { schema: "audit", name: "log", kind: "table", rowEstimate: 12 },
  ],
};

const filter = (over: Partial<ObjectFilter> = {}): ObjectFilter => ({ query: "", fields: ["name"], onlyWithRows: false, sort: "name", ...over });

function structure(name: string, columns: string[], over: Partial<DbTableStructure> = {}): DbTableStructure {
  return {
    schema: "public", name, kind: "table",
    columns: columns.map((c) => ({ name: c, type: "integer", nullable: true, defaultValue: null, comment: null, autoIncrement: false, generated: false })),
    primaryKey: null, foreignKeys: [], references: [], indexes: [], uniques: [], checks: [], comment: null, rowKey: [], rowKeyIsRowid: false,
    ...over,
  };
}

function fk(columns: string[], refTable: string, refColumns: string[]): DbTableStructure["foreignKeys"][number] {
  return { name: null, schema: "public", table: "x", columns, refSchema: "public", refTable, refColumns, onDelete: "NO ACTION", onUpdate: "NO ACTION" };
}

const usersStructure: DbTableStructure = {
  ...structure("users", ["id", "team_id", "email"], {
    primaryKey: { name: "users_pkey", columns: ["id"] },
    foreignKeys: [fk(["team_id"], "teams", ["id"])],
  }),
  columns: [
    { name: "id", type: "integer", nullable: false, defaultValue: null, comment: null, autoIncrement: true, generated: false },
    { name: "team_id", type: "integer", nullable: true, defaultValue: null, comment: null, autoIncrement: false, generated: false },
    { name: "email", type: "text", nullable: false, defaultValue: null, comment: null, autoIncrement: false, generated: false },
  ],
};

function input(over: Partial<ObjectTreeInput> = {}): ObjectTreeInput {
  return {
    ref, list, schema: "public", filter: filter(), openGroups: ["table", "view", "function", "trigger"],
    expandedObjects: new Set(), structures: {}, shown: {}, ...over,
  };
}

function describeRow(r: ObjectTreeRow): string {
  switch (r.kind) {
    case "group": return `${r.label} (${r.count})${r.open ? "" : " closed"}`;
    case "object": return `  ${r.object.name}${r.showArgs ? `(${r.object.args})` : ""}${r.expandable ? (r.expanded ? " −" : " +") : ""}`;
    case "column": return `    ${r.column.name} ${r.column.type}${r.column.pk ? " pk" : ""}${r.column.fk ? ` → ${r.column.fk}` : ""}`;
    case "columns-loading": return "    loading";
    case "columns-error": return `    error ${r.message}`;
    case "more": return `  ${r.hidden} more`;
  }
}

const tree = (over: Partial<ObjectTreeInput> = {}) => objectTreeRows(input(over)).map(describeRow);

const users = list.objects[0]!;
const usersKey = objectNodeKey(ref, users);

describe("the object tree", () => {
  it("lists the picked schema's objects in DBGate's group order, empty groups left out", () => {
    expect(tree()).toEqual([
      "Tables (2)", "  orders +", "  users +",
      "Views (1)", "  active_users +",
      "Functions (3)", "  stamp", "  total(integer)", "  total(integer, integer)",
      "Triggers (1)", "  users_audit",
    ]);
    expect(tree({ schema: "audit" })).toEqual(["Tables (1)", "  log +"]);
  });

  it("gives overloads and a table's same-named trigger rows of their own", () => {
    const keys = objectTreeRows(input()).filter((r) => r.kind === "object").map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    const twin: DbObject = { schema: "public", name: "users", kind: "trigger", table: "users" };
    expect(objectRowKey(twin)).not.toBe(objectRowKey(users));
  });

  it("keeps a closed group's objects out, but a search opens every group with a match", () => {
    expect(tree({ openGroups: ["view"] })).toEqual(["Tables (2) closed", "Views (1)", "  active_users +", "Functions (3) closed", "Triggers (1) closed"]);
    expect(tree({ openGroups: [], filter: filter({ query: "user" }) })).toEqual([
      "Tables (1)", "  users +", "Views (1)", "  active_users +", "Triggers (1)", "  users_audit",
    ]);
  });

  it("shows a table's columns with their keys once it is expanded, and asks for them until then", () => {
    const tables: DbObjectList = { schemas: ["public"], objects: list.objects.filter((o) => o.kind === "table") };
    const tree = (over: Partial<ObjectTreeInput>) => objectTreeRows(input({ list: tables, ...over })).map(describeRow);
    const expandedObjects = new Set([usersKey]);
    const loading = objectTreeRows(input({ list: tables, openGroups: ["table"], expandedObjects }));
    expect(loading.map(describeRow)).toEqual(["Tables (2)", "  orders +", "  users −", "    loading"]);
    expect(structuresToRead(loading, {})).toEqual([{ nodeKey: usersKey, object: users }]);
    // Asked for already: not asked again.
    expect(structuresToRead(loading, { [usersKey]: { state: "loading" } })).toEqual([]);

    const structures = { [usersKey]: { state: "ready" as const, data: usersStructure } };
    expect(tree({ openGroups: ["table"], expandedObjects, structures })).toEqual([
      "Tables (2)", "  orders +", "  users −", "    id integer pk", "    team_id integer → teams.id", "    email text",
    ]);
    expect(tree({ openGroups: ["table"], expandedObjects, structures: { [usersKey]: { state: "error", message: "gone", driver: null } } }))
      .toEqual(["Tables (2)", "  orders +", "  users −", "    error gone"]);
  });

  it("marks every column of a composite key, each pointing at its own counterpart", () => {
    const s = structure("shipments", ["order_id", "line_no", "note"], {
      primaryKey: { name: null, columns: ["order_id", "line_no"] },
      foreignKeys: [fk(["order_id", "line_no"], "order_lines", ["order_id", "no"])],
    });
    expect(structureColumns(s)).toEqual([
      { name: "order_id", type: "integer", pk: true, fk: "order_lines.order_id" },
      { name: "line_no", type: "integer", pk: true, fk: "order_lines.no" },
      { name: "note", type: "integer", pk: false, fk: null },
    ]);
  });

  it("opens a table a column search matched, listing its columns without keys until they are read", () => {
    const columns = columnsByTable([
      { schema: "public", table: "users", name: "email", type: "text" },
      { schema: "public", table: "users", name: "id", type: "integer" },
      { schema: "public", table: "orders", name: "id", type: "integer" },
    ]);
    const rows = tree({ openGroups: [], filter: filter({ query: "mail", fields: ["column"], columns }) });
    expect(rows).toEqual(["Tables (1)", "  users −", "    email text", "    id integer"]);
  });

  it("drops empty tables when asked to, but not tables the engine keeps no count for", () => {
    const withUnknown: DbObjectList = { schemas: [], objects: [...list.objects, { schema: "public", name: "blob", kind: "table" }] };
    expect(tree({ list: withUnknown, openGroups: ["table"], filter: filter({ onlyWithRows: true }) }))
      .toEqual(["Tables (2)", "  blob +", "  users +", "Views (1) closed", "Functions (3) closed", "Triggers (1) closed"]);
  });

  it("sorts by row count, largest first", () => {
    expect(tree({ openGroups: ["table"], filter: filter({ sort: "rows" }) }).slice(0, 3)).toEqual(["Tables (2)", "  users +", "  orders +"]);
  });

  it("cuts a long group at a page and says how many are left", () => {
    const many: DbObjectList = {
      schemas: [],
      objects: Array.from({ length: GROUP_PAGE + 5 }, (_, i) => ({ schema: null, name: `t${String(i).padStart(4, "0")}`, kind: "table" as const })),
    };
    const rows = objectTreeRows(input({ list: many, schema: null, openGroups: ["table"] }));
    expect(rows.filter((r) => r.kind === "object")).toHaveLength(GROUP_PAGE);
    expect(rows.at(-1)).toMatchObject({ kind: "more", group: "table", hidden: 5 });
    expect(rows[0]).toMatchObject({ kind: "group", count: GROUP_PAGE + 5 });
    const all = objectTreeRows(input({ list: many, schema: null, openGroups: ["table"], shown: { table: GROUP_PAGE + 500 } }));
    expect(all.filter((r) => r.kind === "object")).toHaveLength(GROUP_PAGE + 5);
    expect(all.some((r) => r.kind === "more")).toBe(false);
  });
});

describe("the SQL a menu opens a query tab with", () => {
  it("names a Postgres object with its schema and quotes every name for its engine", () => {
    expect(selectTemplate({ schema: "public", name: "users" }, "postgres")).toBe('SELECT * FROM "public"."users" LIMIT 100');
    expect(selectTemplate({ schema: "shop", name: "order items" }, "mysql")).toBe("SELECT * FROM `order items` LIMIT 100");
    expect(selectTemplate({ schema: "shop", name: "x" }, "mariadb")).toBe("SELECT * FROM `x` LIMIT 100");
    expect(selectTemplate({ schema: null, name: 'we"ird' }, "sqlite")).toBe('SELECT * FROM "we""ird" LIMIT 100');
    expect(qualifiedName({ schema: "a`b", name: "c`d" }, "mysql")).toBe("`c``d`");
  });

  it("calls a routine with its arguments left to fill in, and nothing else", () => {
    expect(callTemplate({ schema: "public", name: "total", kind: "function", args: "integer, integer" }, "postgres"))
      .toBe('SELECT "public"."total"(/* integer, integer */)');
    expect(callTemplate({ schema: "shop", name: "refresh", kind: "procedure" }, "mysql")).toBe("CALL `refresh`()");
    expect(callTemplate({ schema: "public", name: "t", kind: "trigger" }, "postgres")).toBeNull();
    expect(callTemplate({ schema: "public", name: "s", kind: "sequence" }, "postgres")).toBeNull();
  });

  it("offers the routine each engine writes: functions in Postgres, procedures in MySQL, none in SQLite", () => {
    expect(routineTemplateKind("postgres")).toBe("function");
    expect(routineTemplateKind("mysql")).toBe("procedure");
    expect(routineTemplateKind("mariadb")).toBe("procedure");
    expect(routineTemplateKind("sqlite")).toBeNull();
    expect(createRoutineTemplate("postgres")).toContain("CREATE OR REPLACE FUNCTION");
    expect(createRoutineTemplate("mysql")).toContain("DELIMITER //");
    expect(createRoutineTemplate("sqlite")).toBeNull();
  });

  it("writes CREATE VIEW and CREATE TRIGGER in each engine's own syntax", () => {
    expect(createViewTemplate("mysql")).toContain("CREATE VIEW `view_name` AS");
    expect(createViewTemplate("postgres")).toContain('CREATE VIEW "view_name" AS');
    expect(createTriggerTemplate("postgres")).toContain("EXECUTE FUNCTION trigger_function_name()");
    expect(createTriggerTemplate("mysql")).toContain("FOR EACH ROW");
    expect(createTriggerTemplate("sqlite")).toContain("BEGIN");
  });
});
