/**
 * What the Structure tab shows of a table and what its column menu copies: which indexes get the
 * Indexes section (not the primary key's, not a unique constraint's), how a foreign key names the
 * table it points at, and each column's definition as CREATE TABLE spells it in each engine.
 */
import { describe, expect, it } from "bun:test";
import {
  columnDefinition, columnDefinitions, columnNames, columnRows, foreignKeyRow, ownIndexes,
} from "../../../src/web/components/database/structure/structure-model.ts";
import type { DbForeignKey, DbIndex, DbStructureColumn, DbTableStructure } from "../../../src/shared/db-structure.ts";

const col = (name: string, extra: Partial<DbStructureColumn> = {}): DbStructureColumn => ({
  name, type: "integer", nullable: true, defaultValue: null, comment: null, autoIncrement: false, generated: false, computedExpression: null,
  ...extra,
});
const index = (name: string, columns: string[], extra: Partial<DbIndex> = {}): DbIndex => ({
  name, columns, keys: columns.map((column) => ({ column, expression: null, descending: false })), unique: false, primary: false, where: null, method: null, ...extra,
});
const fk = (extra: Partial<DbForeignKey> = {}): DbForeignKey => ({
  name: "orders_user_fk", schema: "public", table: "orders", columns: ["user_id"],
  refSchema: "public", refTable: "users", refColumns: ["id"], onDelete: "CASCADE", onUpdate: "NO ACTION",
  ...extra,
} as DbForeignKey);
const structure = (extra: Partial<DbTableStructure> = {}): DbTableStructure => ({
  schema: "public", name: "orders", kind: "table", columns: [], primaryKey: null, foreignKeys: [], references: [],
  indexes: [], uniques: [], checks: [], comment: null, rowKey: [], rowKeyIsRowid: false,
  ...extra,
});

describe("the Columns section", () => {
  it("numbers the columns and marks the primary key's before a foreign key's", () => {
    const rows = columnRows(structure({
      columns: [col("id", { nullable: false }), col("user_id", { comment: "who" }), col("note", { type: "text", defaultValue: "'x'" }), col("total", { generated: true, computedExpression: "qty * price" })],
      primaryKey: { name: "orders_pkey", columns: ["id"] },
      // The key column is in a foreign key too: the key icon wins.
      foreignKeys: [fk(), fk({ name: "self", columns: ["id"] })],
    }));
    expect(rows.map((r) => [r.ordinal, r.name, r.role, r.notNull])).toEqual([
      [1, "id", "pk", true], [2, "user_id", "fk", false], [3, "note", null, false], [4, "total", null, false],
    ]);
    expect(rows[1]!.comment).toBe("who");
    expect(rows[2]!.defaultValue).toBe("'x'");
    expect(rows[2]!.computedExpression).toBe("");
    expect(rows[3]!.computedExpression).toBe("qty * price");
    expect(rows[0]!.defaultValue).toBe("");
    expect(rows[0]!.comment).toBe("");
  });
});

describe("the Indexes section", () => {
  it("leaves out the primary key's index and the ones unique constraints own, by name or by columns", () => {
    const s = structure({
      indexes: [
        index("orders_pkey", ["id"], { unique: true, primary: true }),
        index("orders_code_key", ["code"], { unique: true }),
        // SQLite names neither the constraint nor, usefully, its index.
        index("sqlite_autoindex_orders_2", ["a", "b"], { unique: true }),
        index("orders_created_idx", ["created_at"]),
        index("orders_ab_plain", ["a", "b"]),
        index("orders_ba_unique", ["b", "a"], { unique: true }),
      ],
      uniques: [{ name: "orders_code_key", columns: ["code"] }, { name: null, columns: ["a", "b"] }],
    });
    expect(ownIndexes(s).map((i) => i.name)).toEqual(["orders_created_idx", "orders_ab_plain", "orders_ba_unique"]);
  });

  it("keeps a unique index that no constraint owns", () => {
    const s = structure({ indexes: [index("users_email_idx", ["email"], { unique: true })], uniques: [{ name: "other", columns: ["email"] }] });
    expect(ownIndexes(s).map((i) => i.name)).toEqual(["users_email_idx"]);
  });
});

describe("the Foreign keys and Dependencies sections", () => {
  it("names the table pointed at by schema only when it is another schema", () => {
    expect(foreignKeyRow(fk(), "public")).toEqual({
      name: "orders_user_fk", baseColumns: "user_id", refTable: "users", refColumns: "id",
      onUpdate: "NO ACTION", onDelete: "CASCADE", holder: "orders",
    });
    expect(foreignKeyRow(fk({ refSchema: "auth" }), "public").refTable).toBe("auth.users");
    expect(foreignKeyRow(fk({ refSchema: null, schema: null }), null).refTable).toBe("users");
  });

  it("lists a composite key's columns in key order, and says which table holds a dependency", () => {
    const row = foreignKeyRow(fk({ columns: ["b", "a"], refColumns: ["y", "x"], schema: "sales", table: "lines" }), "public");
    expect(row.baseColumns).toBe("b, a");
    expect(row.refColumns).toBe("y, x");
    expect(row.holder).toBe("sales.lines");
  });
});

describe("Copy names and Copy definitions", () => {
  it("copies names as a SELECT list takes them", () => {
    expect(columnNames(["id", "user_id"])).toBe("id, user_id");
    expect(columnNames([])).toBe("");
  });

  it("spells a column as CREATE TABLE does, quoted for the engine", () => {
    const c = col("user id", { type: "varchar(20)", nullable: false, defaultValue: "'guest'" });
    expect(columnDefinition(c, "postgres")).toBe(`"user id" varchar(20) NOT NULL DEFAULT 'guest'`);
    expect(columnDefinition(c, "mysql")).toBe("`user id` varchar(20) NOT NULL DEFAULT 'guest'");
    expect(columnDefinition(c, "sqlite")).toBe(`"user id" varchar(20) NOT NULL DEFAULT 'guest'`);
    expect(columnDefinition(col("a\"b"), "postgres")).toBe(`"a""b" integer`);
    expect(columnDefinition(col("a`b"), "mysql")).toBe("`a``b` integer");
  });

  it("says a generated column's expression, stored in Postgres, and no default for it", () => {
    const total = col("total", { generated: true, computedExpression: "qty * price", defaultValue: "0" });
    expect(columnDefinition(total, "postgres")).toBe(`"total" integer GENERATED ALWAYS AS (qty * price) STORED`);
    expect(columnDefinition(total, "mysql")).toBe("`total` integer GENERATED ALWAYS AS (qty * price)");
    expect(columnDefinition(total, "sqlite")).toBe(`"total" integer GENERATED ALWAYS AS (qty * price)`);
  });

  it("says a column fills itself in the engine's own words", () => {
    const serial = col("id", { nullable: false, autoIncrement: true, defaultValue: "nextval('orders_id_seq'::regclass)" });
    expect(columnDefinition(serial, "postgres")).toBe(`"id" integer NOT NULL DEFAULT nextval('orders_id_seq'::regclass)`);
    const identity = col("id", { nullable: false, autoIncrement: true });
    expect(columnDefinition(identity, "postgres")).toBe(`"id" integer NOT NULL GENERATED BY DEFAULT AS IDENTITY`);
    expect(columnDefinition(identity, "mysql")).toBe("`id` integer NOT NULL AUTO_INCREMENT");
    // SQLite's rowid alias is the INTEGER PRIMARY KEY itself; there is nothing to add to the column.
    expect(columnDefinition(identity, "sqlite")).toBe(`"id" integer NOT NULL`);
  });

  it("puts one definition on each line", () => {
    expect(columnDefinitions([col("a", { nullable: false }), col("b", { type: "text" })], "postgres")).toBe(`"a" integer NOT NULL,\n"b" text`);
  });
});
