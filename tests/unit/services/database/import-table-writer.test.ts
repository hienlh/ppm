/**
 * Import's table writer, without a database: what each action plans against a table that is or is
 * not there, which columns are written, and what each value is bound as on each engine — the
 * statements a write session would run, captured.
 */
import { describe, expect, it } from "bun:test";
import { ImportRowWriter, ImportTableError, planImportTable, type ImportColumn } from "../../../../src/services/database/impexp/import-table-writer.ts";
import { JsonText, type FileValue } from "../../../../src/services/database/impexp/readers/file-rows.ts";
import type { MappedColumns } from "../../../../src/services/database/impexp/column-map.ts";
import type { DbForeignKey, DbStructureColumn, DbTableStructure } from "../../../../src/shared/db-structure.ts";
import type { DbType } from "../../../../src/shared/db-types.ts";
import type { DbStatement, DbWriteSession } from "../../../../src/types/database.ts";

function column(name: string, type: string, more: Partial<DbStructureColumn> = {}): DbStructureColumn {
  return { name, type, nullable: true, defaultValue: null, comment: null, autoIncrement: false, generated: false, computedExpression: null, ...more };
}

function structure(name: string, columns: DbStructureColumn[], more: Partial<DbTableStructure> = {}): DbTableStructure {
  return {
    schema: null, name, kind: "table", columns, primaryKey: null, foreignKeys: [], references: [], indexes: [], uniques: [], checks: [],
    comment: null, rowKey: [], rowKeyIsRowid: false, ...more,
  };
}

function reference(table: string, onto: string): DbForeignKey {
  return { name: `fk_${table}`, schema: null, table, columns: [`${onto}_id`], refSchema: null, refTable: onto, refColumns: ["id"], onDelete: "CASCADE", onUpdate: "NO ACTION" };
}

const mapped = (...names: string[]): MappedColumns => ({ indexes: names.map((_, i) => i), names });
const t = (name: string, schema: string | null = null) => ({ schema, name });

describe("planImportTable", () => {
  it("creates a missing table with every file column as nullable text, in the type each engine has for any text", () => {
    expect(planImportTable("postgres", "createTable", t("users", "public"), null, mapped("id", "name"))).toEqual({
      ddl: ['CREATE TABLE "public"."users" (\n  "id" text,\n  "name" text\n)'],
      steps: ["Creating table public.users"],
      columns: [{ name: "id", type: "text", kind: "text", index: 0 }, { name: "name", type: "text", kind: "text", index: 1 }],
      warnings: [],
    });
    expect(planImportTable("mysql", "createTable", t("users"), null, mapped("id")).ddl[0]).toContain("`id` longtext");
    expect(planImportTable("sqlite", "truncate", t("users"), null, mapped("id")).ddl[0]).toContain('"id" TEXT');
    expect(planImportTable("mariadb", "dropCreateTable", t("users"), null, mapped("id")).ddl).toHaveLength(1);
  });

  it("appends to a table that exists, writing the columns it has by the very same name", () => {
    const users = structure("users", [column("id", "INTEGER", { autoIncrement: true }), column("name", "TEXT"), column("flag", "BOOLEAN")]);
    const plan = planImportTable("sqlite", "createTable", t("users"), users, { indexes: [2, 0, 1], names: ["name", "Flag", "flag"] });
    expect(plan.ddl).toEqual([]);
    expect(plan.columns).toEqual([{ name: "name", type: "TEXT", kind: "text", index: 2 }, { name: "flag", type: "BOOLEAN", kind: "boolean", index: 1 }]);
    expect(plan.warnings).toEqual(["users has no column Flag: left out"]);
  });

  it("takes a MariaDB LONGTEXT with a json_valid check of its own for the JSON column it is", () => {
    const docs = structure("docs", [column("doc", "longtext"), column("other", "longtext"), column("we`ird", "longtext"), column("n", "int(11)")], {
      checks: [
        { name: "doc", expression: "json_valid(`doc`)" },
        { name: "other", expression: "json_valid(`other`) or `other` is null" },
        { name: "we`ird", expression: "JSON_VALID(`we``ird`)" },
        { name: "n", expression: "`n` > 0" },
      ],
    });
    const kinds = (type: DbType) => planImportTable(type, "appendData", t("docs"), docs, mapped("doc", "other", "we`ird", "n")).columns.map((c) => c.kind);
    expect(kinds("mariadb")).toEqual(["json", "text", "json", "number"]);
    expect(kinds("mysql")).toEqual(["json", "text", "json", "number"]);
    // Only MySQL's family keeps JSON this way.
    expect(planImportTable("postgres", "appendData", t("docs"), { ...docs, columns: [column("doc", "text")] }, mapped("doc")).columns[0]!.kind).toBe("text");
  });

  it("leaves out a column the database computes, and says so", () => {
    const t1 = structure("t1", [column("a", "integer"), column("b", "integer", { generated: true }), column("c", "integer", { generated: true })]);
    const plan = planImportTable("postgres", "appendData", t("t1"), t1, mapped("a", "b", "c", "d"));
    expect(plan.columns.map((c) => c.name)).toEqual(["a"]);
    expect(plan.warnings).toEqual(["t1 has no column d: left out", "b, c are computed by the database: left out"]);
  });

  it("refuses when no file column can be written, before any DDL", () => {
    const t1 = structure("t1", [column("a", "text"), column("g", "text", { generated: true })]);
    expect(() => planImportTable("postgres", "truncate", t("t1"), t1, mapped("x", "y"))).toThrow(new ImportTableError("None of the file's columns can be written to t1: it has no columns x, y"));
    expect(() => planImportTable("postgres", "appendData", t("t1"), t1, mapped("g"))).toThrow("None of the file's columns can be written to t1: it computes g itself");
    expect(() => planImportTable("postgres", "appendData", t("t1"), t1, mapped("z", "g"))).toThrow("it has no column z, and it computes g itself");
  });

  it("Append data refuses a table that is not there, as DBGate does", () => {
    expect(() => planImportTable("mysql", "appendData", t("nope"), null, mapped("a"))).toThrow(new ImportTableError("Table nope not found"));
    expect(() => planImportTable("postgres", "appendData", t("nope", "s"), null, mapped("a"))).toThrow("Table s.nope not found");
  });

  it("refuses a view, whichever the action", () => {
    const v = structure("v", [column("a", "text")], { kind: "view" });
    expect(() => planImportTable("postgres", "createTable", t("v"), v, mapped("a"))).toThrow("v is a view: import into a table");
    expect(() => planImportTable("postgres", "dropCreateTable", t("m"), { ...v, name: "m", kind: "matview" }, mapped("a"))).toThrow("m is a materialized view");
  });

  it("Truncate and import empties the table first: TRUNCATE, or SQLite's DELETE FROM", () => {
    const users = structure("users", [column("a", "text")]);
    expect(planImportTable("postgres", "truncate", t("users", "public"), users, mapped("a"))).toMatchObject({
      ddl: ['TRUNCATE TABLE "public"."users"'], steps: ["Deleting the rows of public.users"],
    });
    expect(planImportTable("mysql", "truncate", t("users"), users, mapped("a")).ddl).toEqual(["TRUNCATE TABLE `users`"]);
    expect(planImportTable("sqlite", "truncate", t("users"), users, mapped("a")).ddl).toEqual(['DELETE FROM "users"']);
  });

  it("refuses to empty a SQLite table another one points at, as Postgres and MySQL refuse to TRUNCATE it", () => {
    const parent = structure("parent", [column("id", "INTEGER")], { references: [reference("child", "parent"), reference("parent", "parent")] });
    expect(() => planImportTable("sqlite", "truncate", t("parent"), parent, mapped("id")))
      .toThrow(new ImportTableError("child has a foreign key onto parent, so its rows cannot all be deleted: choose Append data, or remove the key in the Structure tab first"));
    const selfOnly = structure("parent", [column("id", "INTEGER")], { references: [reference("parent", "parent")] });
    expect(planImportTable("sqlite", "truncate", t("parent"), selfOnly, mapped("id")).ddl).toEqual(['DELETE FROM "parent"']);
  });

  it("Drop and create table drops the table and creates it from the file", () => {
    const users = structure("users", [column("old", "integer")], { references: [reference("orders", "users")] });
    expect(planImportTable("postgres", "dropCreateTable", t("users", "public"), users, mapped("a"))).toMatchObject({
      ddl: ['DROP TABLE "public"."users"', 'CREATE TABLE "public"."users" (\n  "a" text\n)'],
      steps: ["Dropping table public.users", "Creating table public.users"],
      columns: [{ name: "a", kind: "text" }],
    });
    expect(() => planImportTable("sqlite", "dropCreateTable", t("users"), { ...users, references: [reference("orders", "users")] }, mapped("a"))).toThrow(/orders has a foreign key onto users/);
  });
});

/** A write session that keeps what it is asked to run. */
function fakeSession(maxParams = 65_535) {
  const runs: DbStatement[] = [];
  const session: DbWriteSession = {
    maxParams,
    ddl: async () => {},
    run: async (stmt) => {
      runs.push(stmt);
      return stmt.params.length;
    },
    commit: async () => {},
    close: async () => {},
    cancel: () => {},
  };
  return { session, runs };
}

const col = (name: string, type: string, kind: ImportColumn["kind"], index: number): ImportColumn => ({ name, type, kind, index });

async function bound(type: DbType, columns: ImportColumn[], rows: FileValue[][], fromJson = false) {
  const { session, runs } = fakeSession();
  const writer = new ImportRowWriter(session, type, t("t"), columns, fromJson);
  await writer.write(rows);
  await writer.flush();
  return runs;
}

describe("ImportRowWriter statements", () => {
  it("writes many rows to one INSERT, with Postgres casting the text of a boolean and a JSON value", async () => {
    const runs = await bound("postgres", [col("n", "integer", "number", 0), col("b", "boolean", "boolean", 1), col("j", "jsonb", "json", 2), col("x", "bytea", "binary", 3)], [
      ["1", "true", '{"a":1}', "AAE="],
      [null, null, null, null],
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.sql).toBe(
      'INSERT INTO "public"."t" ("n", "b", "j", "x") VALUES ($1, CAST($2::text AS boolean), CAST($3::text AS jsonb), $4), ($5, CAST($6::text AS boolean), CAST($7::text AS jsonb), $8)',
    );
    expect(runs[0]!.params).toEqual(["1", "true", '{"a":1}', Buffer.from([0, 1]), null, null, null, null]);
  });

  it("uses ? on MySQL and SQLite, and qualifies a Postgres table with its schema", async () => {
    expect((await bound("mysql", [col("a", "text", "text", 0)], [["x"]]))[0]!.sql).toBe("INSERT INTO `t` (`a`) VALUES (?)");
    expect((await bound("sqlite", [col("a", "TEXT", "text", 0)], [["x"], ["y"]]))[0]!.sql).toBe('INSERT INTO "t" ("a") VALUES (?), (?)');
    const { session, runs } = fakeSession();
    const writer = new ImportRowWriter(session, "postgres", t("t", "sales"), [col("a", "text", "text", 0)], false);
    await writer.write([["x"]]);
    await writer.flush();
    expect(runs[0]!.sql).toBe('INSERT INTO "sales"."t" ("a") VALUES ($1)');
    expect(writer.template).toBe('INSERT INTO "sales"."t" ("a") VALUES ($1)');
  });

  it("takes each value from its place in the file's row", async () => {
    const runs = await bound("sqlite", [col("b", "TEXT", "text", 2), col("a", "TEXT", "text", 0)], [["A", "skipped", "B"]]);
    expect(runs[0]!.params).toEqual(["B", "A"]);
  });

  it("starts a new INSERT once the parameters would pass what the database binds", async () => {
    const { session, runs } = fakeSession(7);
    const writer = new ImportRowWriter(session, "sqlite", t("t"), [col("a", "TEXT", "text", 0), col("b", "TEXT", "text", 1)], false);
    await writer.write(Array.from({ length: 7 }, (_, i) => [String(i), "x"]));
    await writer.flush();
    expect(runs.map((r) => r.params.length / 2)).toEqual([3, 3, 1]);
    expect(writer.written).toBe(14);
  });

  it("starts a new INSERT once the values held pass the byte limit", async () => {
    const { session, runs } = fakeSession();
    const writer = new ImportRowWriter(session, "sqlite", t("t"), [col("a", "TEXT", "text", 0)], false, 10);
    await writer.write([["é".repeat(3)], ["1234"], ["x"], ["y"]]);
    await writer.flush();
    expect(runs.map((r) => r.params)).toEqual([["ééé", "1234"], ["x", "y"]]);
  });

  it("sends nothing for no rows", async () => {
    expect(await bound("postgres", [col("a", "text", "text", 0)], [])).toEqual([]);
  });
});

describe("ImportRowWriter values", () => {
  const one = async (type: DbType, c: ImportColumn, value: FileValue, fromJson = false) => (await bound(type, [c], [[value]], fromJson))[0]!.params[0];

  it("sends a number, a date or any other value as the text the file holds", async () => {
    expect(await one("postgres", col("n", "bigint", "number", 0), new JsonText("9007199254740993"))).toBe("9007199254740993");
    expect(await one("mysql", col("d", "datetime", "datetime", 0), "2024-01-15 10:30:00")).toBe("2024-01-15 10:30:00");
    expect(await one("sqlite", col("o", "TEXT", "text", 0), new JsonText('{"a": [1]}'))).toBe('{"a": [1]}');
    expect(await one("postgres", col("s", "text", "text", 0), true)).toBe("true");
  });

  it("decodes bytes from base64 or PPM's {\"$binary\": …}, and refuses anything else naming row and column", async () => {
    expect(await one("sqlite", col("b", "BLOB", "binary", 0), "AP8=")).toEqual(Buffer.from([0, 255]));
    expect(await one("mysql", col("b", "blob", "binary", 0), "")).toEqual(Buffer.alloc(0));
    expect(await one("postgres", col("b", "bytea", "binary", 0), new JsonText('{"$binary":"AP8=","size":2}'), true)).toEqual(Buffer.from([0, 255]));
    await expect(bound("sqlite", [col("b", "BLOB", "binary", 0)], [["AP8="], ["not base64!"]]))
      .rejects.toThrow(new ImportTableError('Row 2, column b: the value is not base64, nor a {"$binary": …} object'));
    await expect(bound("sqlite", [col("b", "BLOB", "binary", 0)], [["AP8"]])).rejects.toThrow("Row 1, column b");
    await expect(bound("sqlite", [col("b", "BLOB", "binary", 0)], [[new JsonText('{"$binary":"AP8=","truncated":true}')]], true))
      .rejects.toThrow('Row 1, column b: the value holds only the start of its bytes ("truncated": true)');
    await expect(bound("sqlite", [col("b", "BLOB", "binary", 0)], [[new JsonText("[1]")]], true)).rejects.toThrow("is not base64");
    await expect(bound("sqlite", [col("b", "BLOB", "binary", 0)], [[true]], true)).rejects.toThrow("is not base64");
  });

  it("turns a boolean into 1 or 0 on MySQL and SQLite, and leaves Postgres to read the text", async () => {
    const mysqlBool = col("f", "tinyint(1)", "boolean", 0);
    expect(await one("mysql", mysqlBool, true, true)).toBe(1);
    expect(await one("mysql", mysqlBool, false, true)).toBe(0);
    expect(await one("mariadb", mysqlBool, " TRUE ")).toBe(1);
    expect(await one("sqlite", col("f", "BOOLEAN", "boolean", 0), "False")).toBe(0);
    expect(await one("sqlite", col("f", "BOOLEAN", "boolean", 0), "1")).toBe(1);
    expect(await one("sqlite", col("f", "BOOLEAN", "boolean", 0), "0")).toBe(0);
    expect(await one("mysql", mysqlBool, "yes")).toBe("yes");
    expect(await one("postgres", col("f", "boolean", "boolean", 0), false, true)).toBe("false");
    expect(await one("postgres", col("f", "boolean", "boolean", 0), "t")).toBe("t");
  });

  it("writes a JSON file's string into a JSON column as a JSON string, and a CSV field as the document it holds", async () => {
    const json = col("j", "json", "json", 0);
    expect(await one("mysql", json, "hello", true)).toBe('"hello"');
    expect(await one("mysql", json, '{"a":1}', false)).toBe('{"a":1}');
    expect(await one("postgres", json, new JsonText('{"a":9007199254740993}'), true)).toBe('{"a":9007199254740993}');
    expect(await one("postgres", json, true, true)).toBe("true");
  });

  it("writes a JSON array into a Postgres array column as an array's text", async () => {
    const ints = col("a", "integer[]", "other", 0);
    expect(await one("postgres", ints, new JsonText("[1, 2, null]"), true)).toBe('{"1","2",NULL}');
    expect(await one("postgres", ints, "[[1,2],[3,4]]")).toBe('{{"1","2"},{"3","4"}}');
    expect(await one("postgres", col("a", "text[]", "other", 0), new JsonText('["a,b", "say \\"hi\\"", {"k":1}, true]'), true)).toBe('{"a,b","say \\"hi\\"","{\\"k\\":1}","true"}');
    expect(await one("postgres", ints, "{1,2}")).toBe("{1,2}");
    expect(await one("postgres", ints, "[not json")).toBe("[not json");
    expect(await one("postgres", ints, new JsonText("[]"), true)).toBe("{}");
  });
});
