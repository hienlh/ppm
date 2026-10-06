import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractChecks, extractColumnText, extractGeneratedColumns, parseCreateIndex, sqliteGetStructure, sqliteListColumns, sqliteListForeignKeys,
  sqliteListObjects, sqliteRowidAlias,
} from "../../../../src/services/database/analyser-sqlite.ts";
import { sqliteService } from "../../../../src/services/sqlite.service.ts";

const SCHEMA = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT DEFAULT 'anon' CHECK (length(name) > 0),
    label TEXT GENERATED ALWAYS AS (name || ' <' || email || '>') VIRTUAL,
    CONSTRAINT email_shape CHECK (email LIKE '%@%')
  );
  CREATE TABLE "Orgs" (code TEXT, region TEXT, PRIMARY KEY (region, code)) WITHOUT ROWID;
  CREATE TABLE members (
    org_region TEXT,
    org_code TEXT,
    -- Names the parent in another case and leaves its column out: SQLite accepts both.
    user_id INTEGER REFERENCES Users ON DELETE CASCADE,
    FOREIGN KEY (org_region, org_code) REFERENCES orgs (region, code) ON UPDATE SET NULL
  );
  CREATE INDEX members_user ON members (user_id) WHERE user_id IS NOT NULL;
  CREATE INDEX users_lower_email ON users (lower(email));
  CREATE VIEW active_users AS SELECT * FROM users;
  CREATE TRIGGER users_touch AFTER UPDATE ON users BEGIN SELECT 1; END;
  CREATE TABLE logs (msg TEXT);
  CREATE TABLE odd ("rowid" TEXT, n INT);
`;

let db: Database;
let dir: string;
let path: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ppm-analyser-"));
  path = join(dir, "schema.db");
  db = new Database(path);
  db.exec(SCHEMA);
});

afterAll(() => {
  db.close();
  sqliteService.closeAll();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows keeps sqlite handles briefly */ }
});

describe("sqliteListColumns", () => {
  it("lists every column of every table and view in column order, generated ones included", () => {
    const columns = sqliteListColumns(db);
    expect(columns.filter((c) => c.table === "Orgs")).toEqual([
      { schema: null, table: "Orgs", name: "code", type: "TEXT" },
      { schema: null, table: "Orgs", name: "region", type: "TEXT" },
    ]);
    expect(columns.filter((c) => c.table === "users").map((c) => c.name)).toEqual(["id", "email", "name", "label"]);
    expect(columns.filter((c) => c.table === "active_users").map((c) => c.name)).toEqual(["id", "email", "name", "label"]);
    expect(columns.filter((c) => c.table === "odd")).toEqual([
      { schema: null, table: "odd", name: "rowid", type: "TEXT" },
      { schema: null, table: "odd", name: "n", type: "INT" },
    ]);
    expect(columns.some((c) => c.table.startsWith("sqlite_"))).toBe(false);
  });
});

describe("sqliteListObjects", () => {
  it("lists tables, views and triggers, without SQLite's own tables", () => {
    const { schemas, objects } = sqliteListObjects(db);
    expect(schemas).toEqual([]);
    const names = (kind: string) => objects.filter((o) => o.kind === kind).map((o) => o.name).sort();
    expect(names("table")).toEqual(["Orgs", "logs", "members", "odd", "users"]);
    expect(names("view")).toEqual(["active_users"]);
    expect(objects.filter((o) => o.kind === "trigger")).toEqual([{ schema: null, name: "users_touch", kind: "trigger", table: "users" }]);
    expect(objects.some((o) => o.name.startsWith("sqlite_"))).toBe(false);
  });
});

describe("sqliteGetStructure", () => {
  it("describes columns, keys, indexes and checks", () => {
    const s = sqliteGetStructure(db, "users")!;
    expect(s.kind).toBe("table");
    expect(s.columns).toEqual([
      { name: "id", type: "INTEGER", nullable: false, defaultValue: null, comment: null, autoIncrement: true, generated: false, computedExpression: null, collation: null },
      { name: "email", type: "TEXT", nullable: false, defaultValue: null, comment: null, autoIncrement: false, generated: false, computedExpression: null, collation: null },
      { name: "name", type: "TEXT", nullable: true, defaultValue: "'anon'", comment: null, autoIncrement: false, generated: false, computedExpression: null, collation: null },
      {
        name: "label", type: "TEXT", nullable: true, defaultValue: null, comment: null, autoIncrement: false, generated: true,
        computedExpression: "name || ' <' || email || '>'", collation: null, computedStored: false,
      },
    ]);
    expect(s.primaryKey).toEqual({ name: null, columns: ["id"] });
    expect(s.uniques).toEqual([{ name: null, columns: ["email"] }]);
    expect(s.indexes.find((ix) => ix.name === "users_lower_email")).toEqual({
      name: "users_lower_email", columns: ["lower(email)"], unique: false, primary: false, where: null, method: null,
      keys: [{ column: null, expression: "lower(email)", descending: false }],
    });
    expect(s.checks).toEqual([
      { name: null, expression: "length(name) > 0", column: "name" },
      { name: "email_shape", expression: "email LIKE '%@%'" },
    ]);
    expect(s.rowKey).toEqual(["id"]);
    expect(s.rowKeyIsRowid).toBe(false);
  });

  it("lists the keys other tables hold on it", () => {
    expect(sqliteGetStructure(db, "users")!.references).toEqual([{
      name: null, schema: null, table: "members", columns: ["user_id"],
      refSchema: null, refTable: "users", refColumns: ["id"], onDelete: "CASCADE", onUpdate: "NO ACTION",
    }]);
  });

  it("resolves a key that names no parent column, and a parent named in another case", () => {
    const s = sqliteGetStructure(db, "members")!;
    expect(s.foreignKeys).toEqual([
      {
        name: null, schema: null, table: "members", columns: ["org_region", "org_code"],
        refSchema: null, refTable: "Orgs", refColumns: ["region", "code"], onDelete: "NO ACTION", onUpdate: "SET NULL",
      },
      {
        name: null, schema: null, table: "members", columns: ["user_id"],
        refSchema: null, refTable: "users", refColumns: ["id"], onDelete: "CASCADE", onUpdate: "NO ACTION",
      },
    ]);
    expect(s.indexes).toEqual([{
      name: "members_user", columns: ["user_id"], unique: false, primary: false, where: "user_id IS NOT NULL", method: null,
      keys: [{ column: "user_id", expression: null, descending: false }],
    }]);
  });

  it("keys a table without a primary key by its rowid, under a name no column shadows", () => {
    expect(sqliteGetStructure(db, "members")).toMatchObject({ rowKey: ["rowid"], rowKeyIsRowid: true, primaryKey: null });
    expect(sqliteGetStructure(db, "odd")).toMatchObject({ rowKey: ["_rowid_"], rowKeyIsRowid: true });
  });

  it("keeps primary key order, finds the table in any case, and gives WITHOUT ROWID no rowid", () => {
    const s = sqliteGetStructure(db, "orgs")!;
    expect(s.name).toBe("Orgs");
    expect(s.columns.map((c) => c.name)).toEqual(["code", "region"]);
    expect(s.primaryKey).toEqual({ name: null, columns: ["region", "code"] });
    expect(s.rowKey).toEqual(["region", "code"]);
    expect(s.indexes.filter((ix) => ix.primary)).toHaveLength(1);
    expect(s.references.map((k) => k.table)).toEqual(["members"]);
  });

  it("describes a view as a view with no way to address its rows", () => {
    expect(sqliteGetStructure(db, "active_users")).toMatchObject({
      kind: "view", primaryKey: null, foreignKeys: [], references: [], indexes: [], checks: [], rowKey: [], rowKeyIsRowid: false,
    });
  });

  it("answers null for a table that does not exist", () => {
    expect(sqliteGetStructure(db, "nope")).toBeNull();
  });

  // What rebuilding the table has to say again: none of it is in a pragma but the key direction.
  it("keeps what only the CREATE text says: collations, AUTOINCREMENT, STRICT, and each key's direction", () => {
    const own = new Database(":memory:");
    own.exec(`
      CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT COLLATE NOCASE NOT NULL,
        slug TEXT GENERATED ALWAYS AS (lower(name)) STORED
      ) STRICT;
      CREATE INDEX tags_name ON tags (name DESC, id);
      CREATE TABLE plain (id INTEGER PRIMARY KEY, v TEXT);`);
    try {
      const s = sqliteGetStructure(own, "tags")!;
      expect(s.columns.map((c) => [c.name, c.collation, c.sqliteAutoincrement ?? false, c.computedStored])).toEqual([
        ["id", null, true, undefined],
        ["name", "NOCASE", false, undefined],
        ["slug", null, false, true],
      ]);
      expect(s).toMatchObject({ strict: true, withoutRowid: false });
      expect(s.indexes.find((ix) => ix.name === "tags_name")!.keys).toEqual([
        { column: "name", expression: null, descending: true },
        { column: "id", expression: null, descending: false },
      ]);
      // A rowid alias declared without the keyword reuses rowids, which is not the same thing.
      expect(sqliteGetStructure(own, "plain")!.columns[0]).toMatchObject({ autoIncrement: true });
      expect(sqliteGetStructure(own, "plain")!.columns[0]!.sqliteAutoincrement).toBeUndefined();
      expect(sqliteGetStructure(db, "Orgs")).toMatchObject({ strict: false, withoutRowid: true });
    } finally {
      own.close();
    }
  });
});

describe("a table's rowid alias", () => {
  it("is the one INTEGER key of a rowid table, which SQLite numbers itself, and the grid is told so", () => {
    const file = join(dir, "rowid.db");
    const own = new Database(file);
    own.exec(`
      CREATE TABLE plain (id INTEGER PRIMARY KEY, v TEXT);
      CREATE TABLE lower_case (n integer primary key, v TEXT);
      CREATE TABLE table_key (v TEXT, n INTEGER, PRIMARY KEY (n DESC));
      CREATE TABLE not_integer (id INT PRIMARY KEY, v TEXT);
      CREATE TABLE descending (id INTEGER PRIMARY KEY DESC, v TEXT);
      CREATE TABLE pair (a INTEGER, b INTEGER, PRIMARY KEY (a, b));
      CREATE TABLE no_rowid (id INTEGER PRIMARY KEY, v TEXT) WITHOUT ROWID;
      CREATE TABLE no_key (id INTEGER, v TEXT);
      CREATE VIEW plain_view AS SELECT * FROM plain;`);
    try {
      const aliases = Object.fromEntries(["plain", "lower_case", "table_key", "not_integer", "descending", "pair", "no_rowid", "no_key", "plain_view"]
        .map((t) => [t, sqliteRowidAlias(own, t)]));
      expect(aliases).toEqual({
        plain: "id", lower_case: "n",
        // DESC makes no difference written as a table constraint; only `INTEGER PRIMARY KEY DESC` keeps the quirk.
        table_key: "n",
        not_integer: null, descending: null, pair: null, no_rowid: null, no_key: null, plain_view: null,
      });
      // Found in any case, as SQLite finds a table.
      expect(sqliteRowidAlias(own, "PLAIN")).toBe("id");
      // Each one the database fills in: an INSERT that leaves it out is given one.
      for (const [table, column] of Object.entries(aliases)) {
        if (!column || table === "plain_view") continue;
        own.run(`INSERT INTO ${table} (v) VALUES ('x')`);
        expect(own.query(`SELECT ${column} AS n FROM ${table}`).get()).toEqual({ n: 1 });
      }
      expect(() => own.run("INSERT INTO not_integer (v) VALUES ('x')")).not.toThrow();
      expect(own.query("SELECT id FROM not_integer").get()).toEqual({ id: null });

      // What the grid reads for a new row's key cell, and the Structure tab for its column.
      const flags = (t: string) => sqliteService.getTableSchema(file, file, t).map((c) => [c.name, c.autoIncrement]);
      expect(flags("plain")).toEqual([["id", true], ["v", false]]);
      expect(flags("table_key")).toEqual([["v", false], ["n", true]]);
      for (const t of ["not_integer", "descending", "pair", "no_rowid", "no_key", "plain_view"]) {
        expect(flags(t).filter(([, auto]) => auto)).toEqual([]);
      }
      expect(sqliteGetStructure(own, "descending")!.columns[0]).toMatchObject({ autoIncrement: false, nullable: true });
      expect(sqliteGetStructure(own, "table_key")!.columns[1]).toMatchObject({ autoIncrement: true, nullable: false });
    } finally {
      own.close();
    }
  });
});

describe("sqliteListForeignKeys", () => {
  it("lists every key in the database once", () => {
    const keys = sqliteListForeignKeys(db);
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => k.table === "members")).toBe(true);
    expect(keys.map((k) => k.refTable).sort()).toEqual(["Orgs", "users"]);
  });
});

describe("describeTable", () => {
  it("names every rowid alias a key may use, and none where there is no rowid", () => {
    expect(sqliteService.describeTable(path, path, "odd")).toMatchObject({ rowKey: ["_rowid_"], rowKeyIsRowid: true, rowidAliases: ["_rowid_", "oid"] });
    expect(sqliteService.describeTable(path, path, "users")).toMatchObject({ rowKey: ["id"], rowKeyIsRowid: false, rowidAliases: ["rowid", "_rowid_", "oid"] });
    expect(sqliteService.describeTable(path, path, "Orgs")!.rowidAliases).toEqual([]);
    expect(sqliteService.describeTable(path, path, "active_users")!.rowidAliases).toEqual([]);
  });
});

describe("reading the CREATE text", () => {
  it("finds CHECKs, says which column declares one, and ignores the word inside strings, names and comments", () => {
    expect(extractChecks(`CREATE TABLE t (
      a TEXT DEFAULT 'CHECK (x)', -- CHECK (y)
      "CHECK" INT, /* CHECK (z) */
      b INT CHECK (b > (1)),
      CONSTRAINT [pos] CHECK (b >= 0)
    )`)).toEqual([{ name: null, expression: "b > (1)", column: "b" }, { name: "pos", expression: "b >= 0" }]);
  });

  it("finds each generated column's expression, long form and short, and no CAST inside a default", () => {
    expect(Object.fromEntries(extractGeneratedColumns(`CREATE TABLE t (
      a INT,
      b INT DEFAULT (CAST('1' AS INT)),
      "Total" REAL GENERATED ALWAYS AS (a * (b + 1)) STORED,
      [short] AS (a || 'x,y'),
      c TEXT CHECK (CAST(c AS TEXT) <> ''),
      CONSTRAINT k PRIMARY KEY (a)
    )`))).toEqual({ total: "a * (b + 1)", short: "a || 'x,y'" });
  });

  it("reads a column's COLLATE and AUTOINCREMENT only at the column's own level", () => {
    expect(Object.fromEntries(extractColumnText(`CREATE TABLE t (
      "Id" INTEGER PRIMARY KEY AUTOINCREMENT,
      a TEXT DEFAULT ('COLLATE x') COLLATE "rtrim",
      b TEXT CHECK (b COLLATE NOCASE <> ''),
      CONSTRAINT u UNIQUE (a COLLATE NOCASE)
    )`))).toEqual({
      id: { collation: null, autoincrement: true },
      a: { collation: '"rtrim"', autoincrement: false },
      b: { collation: null, autoincrement: false },
    });
  });

  it("splits an index's key list only at its own commas", () => {
    expect(parseCreateIndex(`CREATE INDEX i ON t (coalesce(a, b), c DESC) WHERE a > 0;`))
      .toEqual({ columns: ["coalesce(a, b)", "c DESC"], where: "a > 0" });
  });
});
