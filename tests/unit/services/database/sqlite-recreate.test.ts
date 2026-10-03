import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { sqliteGetStructure } from "../../../../src/services/database/analyser-sqlite.ts";
import { DdlApplyError, ddlScript, type DdlPlan } from "../../../../src/services/database/ddl/ddl-types.ts";
import { sqliteAlterPlan } from "../../../../src/services/database/ddl/sqlite-alter-plan.ts";
import { applySqlitePlan } from "../../../../src/services/database/ddl/sqlite-apply.ts";
import { diffTableModels } from "../../../../src/services/database/ddl/table-diff.ts";
import {
  baseColumnId, columnById, modelFromStructure, removeColumns, upsertColumn, upsertItem, type TableModel,
} from "../../../../src/shared/db-table-model.ts";

const SCHEMA = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (length(name) > 0),
    email TEXT COLLATE NOCASE,
    age INT,
    flag INT CHECK (flag IN (0, 1)),
    CONSTRAINT uq_email UNIQUE (email)
  );
  CREATE INDEX ix_users_name ON users (name DESC);
  CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id) ON DELETE CASCADE, total REAL);
  CREATE VIEW v_users AS SELECT id, name, age FROM users;
  CREATE TABLE log (msg TEXT);
  CREATE TRIGGER trg_users AFTER UPDATE OF name ON users BEGIN INSERT INTO log VALUES ('renamed ' || new.name); END;
  INSERT INTO users (name, email, age, flag) VALUES ('ann', 'a@x', 30, 1), ('bob', 'b@x', NULL, 0), ('cid', 'c@x', 41, NULL), ('dee', 'd@x', 22, 1), ('eve', 'e@x', 50, 0);
  DELETE FROM users WHERE id = 5;
  INSERT INTO orders (user_id, total) VALUES (1, 9.5), (1, 3), (2, 7);
`;

function open(schema = SCHEMA): Database {
  const db = new Database(":memory:");
  db.exec(schema);
  // As PPM's own handles do (sqlite.service.ts).
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function modelOf(db: Database, table: string): TableModel {
  return modelFromStructure(sqliteGetStructure(db, table)!, "sqlite");
}

/** The plan for `edit`, as the Save dialog would be shown it. */
function planFor(db: Database, table: string, edit: (m: TableModel) => TableModel): DdlPlan {
  const base = modelOf(db, table);
  const current = edit(base);
  return sqliteAlterPlan(db, base, current, diffTableModels(base, current));
}

/** The column the catalog called `name` — whatever the edit has renamed it to since. */
const idOf = (_model: TableModel, name: string) => baseColumnId(name);

function change(model: TableModel, name: string, patch: Partial<TableModel["columns"][number]>): TableModel {
  return upsertColumn(model, { ...columnById(model, baseColumnId(name))!, ...patch });
}
const rows = (db: Database, sql: string) => db.query(sql).all();
const pragma = (db: Database, name: string) => Object.values(db.query(`PRAGMA ${name}`).get() as object)[0];

describe("rebuilding a SQLite table", () => {
  it("keeps rows, rowids, the AUTOINCREMENT counter, checks, collation, index, trigger and the child's key", () => {
    const db = open();
    const plan = planFor(db, "users", (m) => change(m, "age", { type: "TEXT" }));
    expect(plan.recreate).toBe(true);
    expect(plan.warnings[0]).toBe("SQLite cannot change the column age in place");
    applySqlitePlan(db, plan);

    expect(rows(db, "SELECT id, name, email, age, typeof(age) AS t FROM users ORDER BY id")).toEqual([
      { id: 1, name: "ann", email: "a@x", age: "30", t: "text" },
      { id: 2, name: "bob", email: "b@x", age: null, t: "null" },
      { id: 3, name: "cid", email: "c@x", age: "41", t: "text" },
      { id: 4, name: "dee", email: "d@x", age: "22", t: "text" },
    ]);
    // AUTOINCREMENT never hands out 5 again, which a new table would.
    db.exec("INSERT INTO users (name) VALUES ('fay')");
    expect(rows(db, "SELECT max(id) AS id FROM users")).toEqual([{ id: 6 }]);

    expect(() => db.exec("INSERT INTO users (name) VALUES ('')")).toThrow(/CHECK constraint failed/);
    expect(() => db.exec("INSERT INTO users (name, flag) VALUES ('x', 2)")).toThrow(/CHECK constraint failed/);
    expect(() => db.exec("INSERT INTO users (name, email) VALUES ('x', 'A@X')")).toThrow(/UNIQUE constraint failed/);
    expect(rows(db, "SELECT sql FROM sqlite_schema WHERE name = 'ix_users_name'")).toEqual([{ sql: "CREATE INDEX ix_users_name ON users (name DESC)" }]);

    db.exec("UPDATE users SET name = 'anna' WHERE id = 1");
    expect(rows(db, "SELECT msg FROM log")).toEqual([{ msg: "renamed anna" }]);
    expect(rows(db, "SELECT count(*) AS n FROM v_users")).toEqual([{ n: 5 }]);

    // The child still points at users — not at the temporary table — and its cascade still runs.
    expect(rows(db, "SELECT \"table\" FROM pragma_foreign_key_list('orders')")).toEqual([{ table: "users" }]);
    db.exec("DELETE FROM users WHERE id = 1");
    expect(rows(db, "SELECT user_id FROM orders")).toEqual([{ user_id: 2 }]);

    expect(rows(db, "SELECT name FROM sqlite_schema WHERE name LIKE 'new_%'")).toEqual([]);
    expect(pragma(db, "foreign_keys")).toBe(1);
    expect(pragma(db, "legacy_alter_table")).toBe(0);
    expect(rows(db, "PRAGMA foreign_key_check")).toEqual([]);
  });

  it("follows SQLite's twelve steps, in their order", () => {
    const db = open();
    const plan = planFor(db, "users", (m) => change(m, "age", { type: "TEXT" }));
    expect(ddlScript(plan.statements)).toBe([
      "PRAGMA foreign_keys = OFF;",
      "CREATE TABLE \"new_users\" (",
      "  \"id\" INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  \"name\" TEXT NOT NULL CHECK (length(name) > 0),",
      "  \"email\" TEXT COLLATE NOCASE,",
      "  \"age\" TEXT,",
      "  \"flag\" INT CHECK (flag IN (0, 1)),",
      "  UNIQUE (\"email\")",
      ");",
      "INSERT INTO \"new_users\" (\"id\", \"name\", \"email\", \"age\", \"flag\") SELECT \"id\", \"name\", \"email\", \"age\", \"flag\" FROM \"users\";",
      "UPDATE \"sqlite_sequence\" SET \"seq\" = max(\"seq\", (SELECT \"seq\" FROM \"sqlite_sequence\" WHERE \"name\" = 'users')) WHERE \"name\" = 'new_users';",
      "INSERT INTO \"sqlite_sequence\" (\"name\", \"seq\") SELECT 'new_users', \"seq\" FROM \"sqlite_sequence\" WHERE \"name\" = 'users' AND NOT EXISTS (SELECT 1 FROM \"sqlite_sequence\" WHERE \"name\" = 'new_users');",
      "DROP TABLE \"users\";",
      "PRAGMA legacy_alter_table = ON;",
      "ALTER TABLE \"new_users\" RENAME TO \"users\";",
      "PRAGMA legacy_alter_table = OFF;",
      "CREATE INDEX ix_users_name ON users (name DESC);",
      "CREATE TRIGGER trg_users AFTER UPDATE OF name ON users BEGIN INSERT INTO log VALUES ('renamed ' || new.name); END;",
      "-- PPM compiles every view and trigger, which the rebuild can leave naming what users no longer has",
      "PRAGMA foreign_key_check;",
      "PRAGMA foreign_keys = ON;",
    ].join("\n"));
  });

  it("renames first, so SQLite rewrites the view, trigger, index and check that name the column", () => {
    const db = open();
    applySqlitePlan(db, planFor(db, "users", (m) => change(change(m, "name", { name: "full_name" }), "age", { type: "TEXT" })));

    expect(rows(db, "SELECT full_name FROM users ORDER BY id LIMIT 1")).toEqual([{ full_name: "ann" }]);
    expect(rows(db, "SELECT * FROM v_users WHERE id = 1")).toEqual([{ id: 1, full_name: "ann", age: "30" }]);
    expect(String((rows(db, "SELECT sql FROM sqlite_schema WHERE name = 'ix_users_name'")[0] as { sql: string }).sql)).toContain("full_name");
    db.exec("UPDATE users SET full_name = 'anna' WHERE id = 1");
    expect(rows(db, "SELECT msg FROM log")).toEqual([{ msg: "renamed anna" }]);
    expect(() => db.exec("INSERT INTO users (full_name) VALUES ('')")).toThrow(/CHECK constraint failed/);
  });

  it("fails whole when a view would be left naming a dropped column, and leaves the table as it was", () => {
    const db = open();
    const before = rows(db, "SELECT sql FROM sqlite_schema ORDER BY name");
    const plan = planFor(db, "users", (m) => change(removeColumns(m, [idOf(m, "age")]), "flag", { type: "TEXT" }));
    expect(plan.recreate).toBe(true);
    let error: unknown;
    try {
      applySqlitePlan(db, plan);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DdlApplyError);
    expect((error as DdlApplyError).message).toBe("The view v_users would no longer work: no such column: age");
    expect((error as DdlApplyError).applied).toBe(0);
    expect(rows(db, "SELECT sql FROM sqlite_schema ORDER BY name")).toEqual(before);
    expect(rows(db, "SELECT count(*) AS n FROM users")).toEqual([{ n: 4 }]);
    expect(pragma(db, "foreign_keys")).toBe(1);
    expect(pragma(db, "legacy_alter_table")).toBe(0);
  });

  it("drops a column's own CHECK with it, and is not stopped by a view that was broken already", () => {
    const db = open(`${SCHEMA} CREATE VIEW broken AS SELECT * FROM ghost;`);
    applySqlitePlan(db, planFor(db, "users", (m) => change(removeColumns(m, [idOf(m, "flag")]), "age", { type: "TEXT" })));
    expect(rows(db, "SELECT name FROM pragma_table_info('users')").map((r) => (r as { name: string }).name)).toEqual(["id", "name", "email", "age"]);
    expect(String((rows(db, "SELECT sql FROM sqlite_schema WHERE name = 'users'")[0] as { sql: string }).sql)).not.toContain("flag");
  });

  it("is not stopped by rows orphaned already, and is by the ones it would orphan", () => {
    const db = open(`${SCHEMA}
      CREATE TABLE items (id INTEGER PRIMARY KEY, owner INTEGER);
      INSERT INTO items (owner) VALUES (1), (42);
      INSERT INTO orders (user_id, total) VALUES (999, 1);`);
    // The orphan in orders predates the rebuild.
    applySqlitePlan(db, planFor(db, "users", (m) => change(m, "age", { type: "TEXT" })));

    const plan = planFor(db, "items", (m) => upsertItem(m, "foreignKeys", {
      id: "n:fk", name: null, columns: [idOf(m, "owner")], refSchema: null, refTable: "users", refColumns: ["id"], onUpdate: null, onDelete: null,
    }));
    expect(plan.warnings[0]).toBe("SQLite cannot change a foreign key in place");
    expect(() => applySqlitePlan(db, plan)).toThrow("Rebuilding items breaks foreign keys: 1 row of items would point at no row of users");
    expect(rows(db, "SELECT count(*) AS n FROM pragma_foreign_key_list('items')")).toEqual([{ n: 0 }]);
  });

  it("swaps two names, and gives a dropped column's name to another", () => {
    const db = open(`
      CREATE TABLE t (a TEXT, b TEXT, c INT, d INT);
      INSERT INTO t VALUES ('a1', 'b1', 3, 4);`);
    applySqlitePlan(db, planFor(db, "t", (m) => {
      let next = change(change(m, "a", { name: "b" }), "b", { name: "a" });
      next = removeColumns(next, [idOf(m, "c")]);
      return change(next, "d", { name: "c", type: "TEXT" });
    }));
    expect(rows(db, "SELECT * FROM t")).toEqual([{ b: "a1", a: "b1", c: "4" }]);
  });

  it("keeps the rowids of a table that has no INTEGER PRIMARY KEY, even with a column named rowid", () => {
    const db = open(`
      CREATE TABLE notes (body TEXT, n INT);
      INSERT INTO notes VALUES ('one', 1), ('two', 2), ('three', 3);
      DELETE FROM notes WHERE n = 2;
      CREATE TABLE odd ("rowid" TEXT, n INT);
      INSERT INTO odd VALUES ('x', 1), ('y', 2);
      DELETE FROM odd WHERE n = 1;`);
    applySqlitePlan(db, planFor(db, "notes", (m) => change(m, "n", { type: "TEXT" })));
    expect(rows(db, "SELECT rowid AS r, body FROM notes")).toEqual([{ r: 1, body: "one" }, { r: 3, body: "three" }]);
    const plan = planFor(db, "odd", (m) => change(m, "n", { type: "TEXT" }));
    expect(plan.statements.find((s) => s.sql.startsWith("INSERT"))!.sql).toBe("INSERT INTO \"new_odd\" (_rowid_, \"rowid\", \"n\") SELECT _rowid_, \"rowid\", \"n\" FROM \"odd\"");
    applySqlitePlan(db, plan);
    expect(rows(db, "SELECT _rowid_ AS r, \"rowid\" AS v FROM odd")).toEqual([{ r: 2, v: "y" }]);
  });

  it("computes generated columns again rather than copying them, from the renamed column", () => {
    const db = open(`
      CREATE TABLE line (price REAL, qty INT, total REAL GENERATED ALWAYS AS (price * qty) STORED);
      INSERT INTO line (price, qty) VALUES (2.5, 4);`);
    applySqlitePlan(db, planFor(db, "line", (m) => change(change(m, "price", { name: "unit_price" }), "qty", { type: "REAL" })));
    expect(rows(db, "SELECT * FROM line")).toEqual([{ unit_price: 2.5, qty: 4, total: 10 }]);
    expect(String((rows(db, "SELECT sql FROM sqlite_schema WHERE name = 'line'")[0] as { sql: string }).sql)).toContain("GENERATED ALWAYS AS (\"unit_price\" * qty) STORED");
  });

  it("gives NULL rows the default of a column turning NOT NULL", () => {
    const db = open();
    applySqlitePlan(db, planFor(db, "users", (m) => change(m, "age", { notNull: true, defaultValue: "0" })));
    expect(rows(db, "SELECT id, age FROM users ORDER BY id")).toEqual([{ id: 1, age: 30 }, { id: 2, age: 0 }, { id: 3, age: 41 }, { id: 4, age: 22 }]);
  });

  it("keeps WITHOUT ROWID and STRICT", () => {
    const db = open(`
      CREATE TABLE kv (k TEXT PRIMARY KEY, v INT) WITHOUT ROWID;
      CREATE TABLE s (a INTEGER, b TEXT) STRICT;
      INSERT INTO kv VALUES ('x', 1);
      INSERT INTO s VALUES (1, 'one');`);
    applySqlitePlan(db, planFor(db, "kv", (m) => change(m, "v", { type: "TEXT" })));
    applySqlitePlan(db, planFor(db, "s", (m) => change(m, "b", { notNull: true })));
    expect(rows(db, "SELECT name, wr, strict FROM pragma_table_list WHERE name IN ('kv', 's') ORDER BY name")).toEqual([
      { name: "kv", wr: 1, strict: 0 },
      { name: "s", wr: 0, strict: 1 },
    ]);
    expect(rows(db, "SELECT * FROM kv")).toEqual([{ k: "x", v: "1" }]);
  });

  it("changes in place — one transaction — what SQLite's ALTER TABLE can, and undoes all of it on failure", () => {
    const db = open();
    const plan = planFor(db, "users", (m) => {
      const renamed = change(m, "email", { name: "mail" });
      return upsertColumn(renamed, { ...columnById(m, idOf(m, "age"))!, id: "n:1", name: "nick", type: "TEXT", notNull: false });
    });
    expect(plan.recreate).toBe(false);
    expect(ddlScript(plan.statements)).toBe([
      "ALTER TABLE \"users\" RENAME COLUMN \"email\" TO \"mail\";",
      "ALTER TABLE \"users\" ADD COLUMN \"nick\" TEXT;",
    ].join("\n"));
    applySqlitePlan(db, plan);
    expect(rows(db, "SELECT mail, nick FROM users WHERE id = 1")).toEqual([{ mail: "a@x", nick: null }]);

    // Dropping the index goes first; the view that needs `age` then stops the drop, and the index is back.
    const failing = planFor(db, "users", (m) => ({ ...removeColumns(m, [idOf(m, "age")]), indexes: [] }));
    expect(failing.recreate).toBe(false);
    expect(() => applySqlitePlan(db, failing)).toThrow(/v_users/);
    expect(rows(db, "SELECT name FROM sqlite_schema WHERE name = 'ix_users_name'")).toEqual([{ name: "ix_users_name" }]);
    expect(rows(db, "SELECT count(*) AS n FROM pragma_table_info('users') WHERE name = 'age'")).toEqual([{ n: 1 }]);
  });
});
