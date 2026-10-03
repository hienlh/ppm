import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  ChangesetRequestError, ChangesetStatementError, buildChangeset, describeFailure, findCascadePaths, parseChangeset,
  type ChangesetTable,
} from "../../../../src/services/database/changeset.ts";
import { classifyPostgresType, postgresDialect } from "../../../../src/services/database/dialect-postgres.ts";
import { classifySqliteType, sqliteDialect } from "../../../../src/services/database/dialect-sqlite.ts";
import { openTestDb, setDb } from "../../../../src/services/db.service.ts";
import { initAdapters } from "../../../../src/services/database/init-adapters.ts";
import { readonlySqliteService, sqliteService } from "../../../../src/services/sqlite.service.ts";
import { databaseRoutes } from "../../../../src/server/routes/database.ts";
import { getAuditDb } from "../../../../src/services/query-audit/query-audit-db.ts";
import { listQueryLogs } from "../../../../src/services/query-audit/query-audit.service.ts";
import { CHANGESET_MAX_OPERATIONS, type ChangesetApplyResult, type ChangesetFailure, type ChangesetPreview } from "../../../../src/shared/db-changeset.ts";
import type { DbForeignKey } from "../../../../src/shared/db-structure.ts";

const pgTable = (name: string, spec: [string, string][], schema = "public"): ChangesetTable => ({
  schema, name, rowidAliases: [],
  columns: spec.map(([n, type]) => ({ name: n, type, kind: classifyPostgresType(type) })),
});
const sqliteTable = (name: string, spec: [string, string][], rowidAliases: string[] = []): ChangesetTable => ({
  schema: null, name, rowidAliases,
  columns: spec.map(([n, type]) => ({ name: n, type, kind: classifySqliteType(type) })),
});
const none = { inserts: [], updates: [], deletes: [], cascade: [] };

function fk(table: string, columns: string[], refTable: string, refColumns: string[], onDelete: DbForeignKey["onDelete"] = "NO ACTION"): DbForeignKey {
  return { name: `${table}_${columns.join("_")}_fk`, schema: "public", table, columns, refSchema: "public", refTable, refColumns, onDelete, onUpdate: "NO ACTION" };
}

describe("parseChangeset", () => {
  it("fills in the default schema, and gives cascade entries the changeset's own", () => {
    const cs = parseChangeset({ table: "t", deletes: [{ key: { id: 1 } }], cascade: [{ table: "c" }] }, "public");
    expect(cs.schema).toBe("public");
    expect(cs.cascade).toEqual([{ schema: "public", table: "c" }]);
    expect(cs.inserts).toEqual([]);
    expect(cs.updates).toEqual([]);
    const other = parseChangeset({ table: "t", schema: "sales", deletes: [{ key: { id: 1 } }], cascade: [{ table: "c" }, { schema: "hr", table: "d" }] }, "public");
    expect(other.cascade).toEqual([{ schema: "sales", table: "c" }, { schema: "hr", table: "d" }]);
  });

  it("refuses what cannot become SQL, saying which change it was", () => {
    const bad = (body: unknown) => () => parseChangeset(body, null);
    expect(bad(null)).toThrow(ChangesetRequestError);
    expect(bad({})).toThrow("table is required");
    expect(bad({ table: "t", updates: {} })).toThrow("updates must be a list");
    expect(bad({ table: "t", updates: [{ key: { id: 1 }, set: {} }] })).toThrow("Update 1 sets no column");
    expect(bad({ table: "t", updates: [{ key: {}, set: { a: 1 } }] })).toThrow("Update 1 needs a key");
    expect(bad({ table: "t", deletes: [{ key: { id: 1 } }, {}] })).toThrow("Delete 2 needs a key");
    expect(bad({ table: "t", inserts: [[1, 2]] })).toThrow("Insert 1 must be an object");
  });

  it("caps how much one changeset may carry", () => {
    const deletes = Array.from({ length: CHANGESET_MAX_OPERATIONS + 1 }, (_, i) => ({ key: { id: i } }));
    expect(() => parseChangeset({ table: "t", deletes }, null)).toThrow(`at most ${CHANGESET_MAX_OPERATIONS} changes`);
  });
});

describe("buildChangeset", () => {
  const users = pgTable("users", [["id", "integer"], ["name", "text"], ["meta", "jsonb"], ["active", "boolean"], ["score", "double precision"]]);

  it("writes parameterised statements beside a written-out copy, in DBGate's order", () => {
    const { statements } = buildChangeset(postgresDialect, users, {
      ...none,
      deletes: [{ key: { id: 5 } }],
      updates: [{ key: { id: 1 }, set: { name: "O'Brien" } }],
      inserts: [{ id: 9, name: "new" }],
    });
    expect(statements.map((s) => s.kind)).toEqual(["insert", "update", "delete"]);
    expect(statements[0]).toMatchObject({
      sql: `INSERT INTO "public"."users" ("id", "name") VALUES ($1, $2)`,
      params: [9, "new"],
      displaySql: `INSERT INTO "public"."users" ("id", "name") VALUES (9, 'new')`,
      expectOne: false,
    });
    expect(statements[1]).toMatchObject({
      sql: `UPDATE "public"."users" SET "name" = $1 WHERE "id" = $2`,
      params: ["O'Brien", 1],
      displaySql: `UPDATE "public"."users" SET "name" = 'O''Brien' WHERE "id" = 1`,
      expectOne: true,
    });
    expect(statements[2]).toMatchObject({ sql: `DELETE FROM "public"."users" WHERE "id" = $1`, params: [5], expectOne: true });
  });

  it("requires the changed columns to still hold what was loaded, and only those", () => {
    const [update] = buildChangeset(postgresDialect, users, {
      ...none,
      updates: [{ key: { id: 1 }, set: { name: "x" }, original: { name: "a", active: true } }],
    }).statements;
    // `active` was not edited: someone else changing it must not refuse this save.
    expect(update!.sql).toBe(`UPDATE "public"."users" SET "name" = $1 WHERE "id" = $2 AND "name" IS NOT DISTINCT FROM $3`);
    expect(update!.params).toEqual(["x", 1, "a"]);
  });

  it("leaves values out of the check that do not come back from the browser byte for byte", () => {
    const [update] = buildChangeset(postgresDialect, users, {
      ...none,
      updates: [{ key: { id: 1 }, set: { meta: { b: 2 }, score: 1.5 }, original: { meta: { b: 1 }, score: 0.1 } }],
    }).statements;
    expect(update!.sql).toBe(`UPDATE "public"."users" SET "meta" = CAST($1::text AS jsonb), "score" = $2 WHERE "id" = $3`);
  });

  it("compares a NULL original with IS, which = cannot do", () => {
    const t = sqliteTable("t", [["id", "INTEGER"], ["a", "TEXT"]]);
    const [update] = buildChangeset(sqliteDialect, t, { ...none, updates: [{ key: { id: 3 }, set: { a: "x" }, original: { a: null } }] }).statements;
    expect(update!.sql).toBe(`UPDATE "t" SET "a" = ? WHERE "id" = ? AND "a" IS ?`);
    expect(update!.displaySql).toBe(`UPDATE "t" SET "a" = 'x' WHERE "id" = 3 AND "a" IS NULL`);
  });

  it("binds a Postgres array as it is, and shows it as Postgres reads one", () => {
    const t = pgTable("t", [["id", "integer"], ["tags", "integer[]"], ["meta", "jsonb"]]);
    const [insert] = buildChangeset(postgresDialect, t, { ...none, inserts: [{ id: 1, tags: [1, 2], meta: [1, 2] }] }).statements;
    expect(insert!.params).toEqual([1, [1, 2], "[1,2]"]);
    expect(insert!.displaySql).toBe(`INSERT INTO "public"."t" ("id", "tags", "meta") VALUES (1, '{"1","2"}', '[1,2]')`);
  });

  it("sends JSON to a Postgres JSON column as text, so it is not encoded twice", () => {
    const [insert] = buildChangeset(postgresDialect, users, { ...none, inserts: [{ meta: { a: [1, 2] } }] }).statements;
    expect(insert!.sql).toBe(`INSERT INTO "public"."users" ("meta") VALUES (CAST($1::text AS jsonb))`);
    expect(insert!.params).toEqual([`{"a":[1,2]}`]);
  });

  it("casts text typed into a Postgres boolean, which the driver would otherwise send as false", () => {
    const [insert] = buildChangeset(postgresDialect, users, { ...none, inserts: [{ active: "true" }] }).statements;
    expect(insert!.sql).toBe(`INSERT INTO "public"."users" ("active") VALUES (CAST($1::text AS boolean))`);
    const [update] = buildChangeset(postgresDialect, users, { ...none, updates: [{ key: { id: 1 }, set: { active: false } }] }).statements;
    expect(update!.sql).toBe(`UPDATE "public"."users" SET "active" = $1 WHERE "id" = $2`);
  });

  it("turns bytes back from their marker and writes them out in the engine's own notation", () => {
    const t = sqliteTable("files", [["id", "INTEGER"], ["data", "BLOB"]]);
    const value = { $binary: Buffer.from([1, 2, 255]).toString("base64"), size: 3 };
    const [insert] = buildChangeset(sqliteDialect, t, { ...none, inserts: [{ id: 1, data: value }] }).statements;
    expect(insert!.params[1]).toEqual(new Uint8Array([1, 2, 255]));
    expect(insert!.displaySql).toBe(`INSERT INTO "files" ("id", "data") VALUES (1, X'0102ff')`);
    const truncated = { ...value, truncated: true };
    expect(() => buildChangeset(sqliteDialect, t, { ...none, deletes: [{ key: { data: truncated } }] })).toThrow("only partly loaded");
  });

  it("merges two edits of one row and deletes a row once", () => {
    const { statements } = buildChangeset(postgresDialect, users, {
      ...none,
      updates: [
        { key: { id: 1 }, set: { name: "x" }, original: { name: "a" } },
        { key: { id: 1 }, set: { name: "y", active: false }, original: { name: "x", active: true } },
      ],
      deletes: [{ key: { id: 5 } }, { key: { id: 5 } }],
    });
    expect(statements).toHaveLength(2);
    // The later value wins; the first original is what the database still holds.
    expect(statements[0]!.displaySql).toBe(
      `UPDATE "public"."users" SET "name" = 'y', "active" = FALSE WHERE "id" = 1 AND "name" IS NOT DISTINCT FROM 'a' AND "active" IS NOT DISTINCT FROM TRUE`,
    );
  });

  it("names a column the table does not have instead of sending it", () => {
    expect(() => buildChangeset(postgresDialect, users, { ...none, updates: [{ key: { id: 1 }, set: { nope: 1 } }] }))
      .toThrow(`Table "users" has no column "nope"`);
    expect(() => buildChangeset(postgresDialect, users, { ...none, deletes: [{ key: { rowid: 1 } }] })).toThrow(`no column "rowid"`);
  });

  it("lets a SQLite key name the rowid, as the older SQLite viewer does", () => {
    const t = sqliteTable("t", [["id", "INTEGER"], ["a", "TEXT"]], ["rowid", "_rowid_", "oid"]);
    const [update] = buildChangeset(sqliteDialect, t, { ...none, updates: [{ key: { ROWID: 3 }, set: { a: true } }] }).statements;
    expect(update!.sql).toBe(`UPDATE "t" SET "a" = ? WHERE "ROWID" = ?`);
    expect(update!.params).toEqual([1, 3]);
  });

  it("inserts a row of defaults when no column is given", () => {
    const [insert] = buildChangeset(sqliteDialect, sqliteTable("t", [["a", "TEXT"]]), { ...none, inserts: [{}] }).statements;
    expect(insert!.sql).toBe(`INSERT INTO "t" DEFAULT VALUES`);
  });
});

describe("cascade deletes", () => {
  const users = pgTable("users", [["id", "integer"]]);
  const keys = [fk("orders", ["user_id"], "users", ["id"]), fk("items", ["order_id"], "orders", ["id"], "CASCADE")];

  it("lists every table pointing at deleted rows, deepest first, with what ticking it adds", () => {
    const { statements, references } = buildChangeset(postgresDialect, users, { ...none, deletes: [{ key: { id: 5 } }] }, keys);
    expect(statements.map((s) => s.kind)).toEqual(["delete"]);
    expect(references.map((r) => r.table)).toEqual(["items", "orders"]);
    expect(references[0]).toEqual({
      schema: "public",
      table: "items",
      paths: [["items", "orders", "users"]],
      // orders → users has no ON DELETE CASCADE, so the database would refuse on its own.
      cascadesInDb: false,
      script: `DELETE FROM "public"."items" WHERE "order_id" IN (SELECT "id" FROM "public"."orders" WHERE "user_id" IN (SELECT "id" FROM "public"."users" WHERE "id" = 5));`,
    });
  });

  it("deletes the ticked tables' rows before the rows they point at", () => {
    const { statements } = buildChangeset(postgresDialect, users, {
      ...none,
      deletes: [{ key: { id: 5 } }, { key: { id: 6 } }],
      cascade: [{ schema: "public", table: "orders" }, { schema: "public", table: "items" }],
    }, keys);
    expect(statements.map((s) => s.kind)).toEqual(["cascade", "cascade", "delete", "delete"]);
    expect(statements[0]!.displaySql).toStartWith(`DELETE FROM "public"."items"`);
    expect(statements[1]!.displaySql).toBe(
      `DELETE FROM "public"."orders" WHERE "user_id" IN (SELECT "id" FROM "public"."users" WHERE ("id" = 5) OR ("id" = 6))`,
    );
    expect(statements.every((s) => s.kind === "cascade" ? !s.expectOne : s.expectOne)).toBe(true);
  });

  it("follows keys of several columns", () => {
    const t = pgTable("orgs_users", [["org", "text"], ["uid", "integer"]]);
    const { references } = buildChangeset(postgresDialect, t, { ...none, deletes: [{ key: { org: "a", uid: 1 } }] }, [
      fk("grants", ["org", "uid"], "orgs_users", ["org", "uid"], "CASCADE"),
    ]);
    expect(references[0]!.script).toBe(
      `DELETE FROM "public"."grants" WHERE ("org", "uid") IN (SELECT "org", "uid" FROM "public"."orgs_users" WHERE "org" = 'a' AND "uid" = 1);`,
    );
    expect(references[0]!.cascadesInDb).toBe(true);
  });

  it("refuses to cascade into a table that does not point at the deleted rows", () => {
    expect(() => buildChangeset(postgresDialect, users, {
      ...none, deletes: [{ key: { id: 1 } }], cascade: [{ schema: "public", table: "unrelated" }],
    }, keys)).toThrow(`"unrelated" does not point at the rows being deleted`);
  });

  it("stops at a cycle and leaves a table's keys to itself alone", () => {
    const paths = findCascadePaths([
      fk("a", ["b_id"], "b", ["id"]),
      fk("b", ["a_id"], "a", ["id"]),
      fk("a", ["parent_id"], "a", ["id"]),
    ], { schema: "public", table: "a" });
    expect(paths.map((p) => p.fks.map((k) => k.table))).toEqual([["b"]]);
  });
});

describe("describeFailure", () => {
  const statements = buildChangeset(postgresDialect, pgTable("t", [["id", "integer"], ["a", "text"]]), {
    ...none,
    inserts: [{ id: 1 }],
    updates: [{ key: { id: 2 }, set: { a: "x" } }],
  }).statements;

  it("says which statement failed, in the Save dialog's numbering", () => {
    const e = new ChangesetStatementError(1, statements[1]!, new Error(`null value in column "a" violates not-null constraint`));
    const { message, data } = describeFailure(e, statements);
    expect(message).toBe(
      `Statement 2 of 2 failed: null value in column "a" violates not-null constraint. Nothing was saved.\nUPDATE "public"."t" SET "a" = 'x' WHERE "id" = 2`,
    );
    expect(data).toEqual({ statementIndex: 1, statementCount: 2, sql: `UPDATE "public"."t" SET "a" = 'x' WHERE "id" = 2` });
  });

  it("tells a row someone else changed from a key that matched several", () => {
    const gone = describeFailure(new ChangesetStatementError(1, statements[1]!, null, 0), statements);
    expect(gone.message).toContain("The row was changed or deleted by someone else since it was loaded. Nothing was saved. Reload to see its current values.");
    expect(gone.data.affected).toBe(0);
    const many = describeFailure(new ChangesetStatementError(1, statements[1]!, null, 3), statements);
    expect(many.message).toContain("The key matched 3 rows instead of one. Nothing was saved.");
  });

  it("blames the commit when every statement ran", () => {
    const { message, data } = describeFailure(new ChangesetStatementError(null, null, new Error("deferred key violated")), statements);
    expect(message).toBe("The commit failed: deferred key violated. Nothing was saved.");
    expect(data).toEqual({ statementCount: 2 });
  });
});

// ---------------------------------------------------------------------------
// Against a real SQLite file, through the routes
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
const app = () => new Hono().route("/db", databaseRoutes);

function seed(sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ppm-changeset-"));
  tempDirs.push(dir);
  const path = join(dir, "target.db");
  const db = new Database(path);
  db.exec(sql);
  db.close();
  return path;
}

function query<T>(path: string, sql: string): T[] {
  const db = new Database(path, { readonly: true });
  try { return db.query(sql).all() as T[]; } finally { db.close(); }
}

async function connect(path: string, readonly = false): Promise<number> {
  const res = await app().request("/db/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "sqlite", name: `cs-${tempDirs.length}`, connectionConfig: { type: "sqlite", path } }),
  });
  const id = ((await res.json()) as { data: { id: number } }).data.id;
  if (!readonly) {
    await app().request(`/db/connections/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ readonly: 0 }),
    });
  }
  return id;
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; data: T; error?: string }> {
  const res = await app().request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ppm-client": "web" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { data: T; error?: string };
  return { status: res.status, data: json.data, error: json.error };
}
const apply = (id: number, body: unknown) => post<ChangesetApplyResult & ChangesetFailure>(`/db/connections/${id}/changeset/apply`, body);
const preview = (id: number, body: unknown) => post<ChangesetPreview>(`/db/connections/${id}/changeset/preview`, body);

const PEOPLE = `
  CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER);
  INSERT INTO people VALUES (1, 'a', 10), (2, 'b', 20), (3, 'c', 30);
`;

beforeEach(() => {
  initAdapters();
  setDb(openTestDb());
  getAuditDb().exec("DELETE FROM query_log");
});

afterAll(() => {
  sqliteService.closeAll();
  readonlySqliteService.closeAll();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows keeps sqlite handles briefly */ }
  }
});

describe("changeset on SQLite", () => {
  it("saves nothing when a new row breaks NOT NULL, and names that statement", async () => {
    const path = seed(PEOPLE);
    const id = await connect(path);
    const res = await apply(id, {
      table: "people",
      updates: [
        { key: { id: 1 }, set: { name: "A" } },
        { key: { id: 2 }, set: { age: 21 } },
        { key: { id: 3 }, set: { name: "C" } },
      ],
      inserts: [{ age: 40 }],
    });
    expect(res.status).toBe(400);
    expect(res.error).toStartWith("Statement 1 of 4 failed: NOT NULL constraint failed: people.name. Nothing was saved.");
    expect(res.data).toMatchObject({ statementIndex: 0, statementCount: 4, sql: `INSERT INTO "people" ("age") VALUES (40)` });
    expect(query(path, "SELECT * FROM people ORDER BY id")).toEqual([
      { id: 1, name: "a", age: 10 }, { id: 2, name: "b", age: 20 }, { id: 3, name: "c", age: 30 },
    ]);
  });

  it("rolls back statements that already ran when a later one fails", async () => {
    const path = seed(PEOPLE);
    const id = await connect(path);
    const res = await apply(id, {
      table: "people",
      inserts: [{ id: 4, name: "d" }],
      updates: [
        { key: { id: 1 }, set: { name: "A" } },
        { key: { id: 2 }, set: { age: 21 } },
        { key: { id: 3 }, set: { name: null } },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.error).toStartWith("Statement 4 of 4 failed: NOT NULL constraint failed: people.name.");
    expect(res.error).toEndWith(`UPDATE "people" SET "name" = NULL WHERE "id" = 3`);
    expect(query(path, "SELECT * FROM people ORDER BY id")).toEqual([
      { id: 1, name: "a", age: 10 }, { id: 2, name: "b", age: 20 }, { id: 3, name: "c", age: 30 },
    ]);
  });

  it("writes every change of a good changeset and audits it once", async () => {
    const path = seed(PEOPLE);
    const id = await connect(path);
    const res = await apply(id, {
      table: "people",
      inserts: [{ id: 4, name: "d", age: 40 }],
      updates: [{ key: { id: 1 }, set: { name: "A" }, original: { name: "a" } }],
      deletes: [{ key: { id: 3 } }],
    });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ inserted: 1, updated: 1, deleted: 1, cascaded: 0 });
    expect(query(path, "SELECT id, name FROM people ORDER BY id")).toEqual([
      { id: 1, name: "A" }, { id: 2, name: "b" }, { id: 4, name: "d" },
    ]);

    const logs = listQueryLogs({ connectionId: id });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ source: "grid", operation: "script", status: "ok", row_count: 3, actor: "human" });
    expect(logs[0]!.sql).toBe([
      `INSERT INTO "people" ("id", "name", "age") VALUES (4, 'd', 40);`,
      `UPDATE "people" SET "name" = 'A' WHERE "id" = 1 AND "name" IS 'a';`,
      `DELETE FROM "people" WHERE "id" = 3;`,
    ].join("\n"));
    expect(JSON.parse(logs[0]!.params_json!)).toEqual({ table: "people", schema: null, inserts: 1, updates: 1, deletes: 1 });
  });

  it("edits and deletes exactly one row of a table keyed by two columns", async () => {
    const path = seed(`
      CREATE TABLE memberships (org TEXT, user_id INTEGER, role TEXT, PRIMARY KEY (org, user_id));
      INSERT INTO memberships VALUES ('a', 1, 'r1'), ('a', 2, 'r2'), ('b', 1, 'r3');
    `);
    const id = await connect(path);
    const res = await apply(id, {
      table: "memberships",
      updates: [{ key: { org: "a", user_id: 1 }, set: { role: "admin" } }],
      deletes: [{ key: { org: "b", user_id: 1 } }],
    });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ updated: 1, deleted: 1 });
    expect(query(path, "SELECT * FROM memberships ORDER BY org, user_id")).toEqual([
      { org: "a", user_id: 1, role: "admin" }, { org: "a", user_id: 2, role: "r2" },
    ]);
  });

  it("refuses a key that matches more than one row", async () => {
    const path = seed(`
      CREATE TABLE memberships (org TEXT, user_id INTEGER, role TEXT, PRIMARY KEY (org, user_id));
      INSERT INTO memberships VALUES ('a', 1, 'r1'), ('b', 1, 'r3');
    `);
    const id = await connect(path);
    const res = await apply(id, { table: "memberships", updates: [{ key: { user_id: 1 }, set: { role: "x" } }] });
    expect(res.status).toBe(409);
    expect(res.error).toContain("The key matched 2 rows instead of one. Nothing was saved.");
    expect(res.data.affected).toBe(2);
    expect(query(path, "SELECT role FROM memberships ORDER BY org")).toEqual([{ role: "r1" }, { role: "r3" }]);
  });

  it("refuses to overwrite a value someone else changed since the row was loaded", async () => {
    const path = seed(PEOPLE);
    const id = await connect(path);
    // Another tab saves first.
    const other = new Database(path);
    other.exec("UPDATE people SET name = 'z' WHERE id = 1");
    other.close();

    const res = await apply(id, { table: "people", updates: [{ key: { id: 1 }, set: { name: "A" }, original: { name: "a" } }] });
    expect(res.status).toBe(409);
    expect(res.error).toContain("The row was changed or deleted by someone else since it was loaded. Nothing was saved. Reload");
    expect(res.data).toMatchObject({ statementIndex: 0, affected: 0 });
    expect(query(path, "SELECT name FROM people WHERE id = 1")).toEqual([{ name: "z" }]);
  });

  it("still saves when someone else changed a different column of the same row", async () => {
    const path = seed(PEOPLE);
    const id = await connect(path);
    const other = new Database(path);
    other.exec("UPDATE people SET age = 99 WHERE id = 1");
    other.close();

    const res = await apply(id, { table: "people", updates: [{ key: { id: 1 }, set: { name: "A" }, original: { name: "a" } }] });
    expect(res.status).toBe(200);
    expect(query(path, "SELECT name, age FROM people WHERE id = 1")).toEqual([{ name: "A", age: 99 }]);
  });

  it("refuses to delete a row that is already gone", async () => {
    const path = seed(PEOPLE);
    const id = await connect(path);
    const res = await apply(id, { table: "people", deletes: [{ key: { id: 2 } }, { key: { id: 7 } }] });
    expect(res.status).toBe(409);
    expect(res.data).toMatchObject({ statementIndex: 1, affected: 0 });
    expect(query(path, "SELECT id FROM people ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("answers 404 for a table that does not exist and 400 for a column that does not", async () => {
    const id = await connect(seed(PEOPLE));
    expect((await apply(id, { table: "nope", deletes: [{ key: { id: 1 } }] })).status).toBe(404);
    const res = await apply(id, { table: "people", updates: [{ key: { id: 1 }, set: { nope: 1 } }] });
    expect(res.status).toBe(400);
    expect(res.error).toBe(`Table "people" has no column "nope"`);
    expect(listQueryLogs({ connectionId: id })).toHaveLength(0);
  });

  it("keys a table without a primary key by its rowid", async () => {
    const path = seed(`CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('x'), ('x'), ('y');`);
    const id = await connect(path);
    const res = await apply(id, { table: "notes", updates: [{ key: { rowid: 2 }, set: { body: "second" } }] });
    expect(res.status).toBe(200);
    expect(query(path, "SELECT rowid AS r, body FROM notes ORDER BY rowid")).toEqual([
      { r: 1, body: "x" }, { r: 2, body: "second" }, { r: 3, body: "y" },
    ]);
  });
});

describe("delete references CASCADE on SQLite", () => {
  const SHOP = `
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));
    CREATE TABLE items (id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id));
    INSERT INTO users VALUES (1, 'one'), (2, 'two');
    INSERT INTO orders VALUES (10, 1), (11, 1), (20, 2);
    INSERT INTO items VALUES (100, 10), (101, 11), (200, 20);
  `;

  it("previews the delete and the tables still pointing at it", async () => {
    const id = await connect(seed(SHOP));
    const res = await preview(id, { table: "users", deletes: [{ key: { id: 1 } }] });
    expect(res.status).toBe(200);
    expect(res.data.script).toBe(`DELETE FROM "users" WHERE "id" = 1;`);
    expect(res.data.statementCount).toBe(1);
    expect(res.data.references.map((r) => ({ table: r.table, paths: r.paths, cascadesInDb: r.cascadesInDb }))).toEqual([
      { table: "items", paths: [["items", "orders", "users"]], cascadesInDb: false },
      { table: "orders", paths: [["orders", "users"]], cascadesInDb: false },
    ]);
  });

  it("is refused by the database without the ticks, and deletes the chain with them", async () => {
    const path = seed(SHOP);
    const id = await connect(path);
    const refused = await apply(id, { table: "users", deletes: [{ key: { id: 1 } }] });
    expect(refused.status).toBe(400);
    expect(refused.error).toContain("FOREIGN KEY constraint failed");

    const res = await apply(id, {
      table: "users",
      deletes: [{ key: { id: 1 } }],
      cascade: [{ table: "orders" }, { table: "items" }],
    });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ deleted: 1, cascaded: 4 });
    expect(query(path, "SELECT id FROM users")).toEqual([{ id: 2 }]);
    expect(query(path, "SELECT id FROM orders")).toEqual([{ id: 20 }]);
    expect(query(path, "SELECT id FROM items")).toEqual([{ id: 200 }]);
    const [log] = listQueryLogs({ connectionId: id, status: "ok" });
    expect(log!.operation).toBe("delete");
    expect(JSON.parse(log!.params_json!).cascade).toEqual([{ schema: null, table: "orders" }, { schema: null, table: "items" }]);
  });

  it("numbers a failure the way the Save dialog lists the script, cascades first", async () => {
    const path = seed(`${SHOP} CREATE TRIGGER no_items BEFORE DELETE ON items BEGIN SELECT RAISE(ABORT, 'items are kept'); END;`);
    const id = await connect(path);
    const res = await apply(id, { table: "users", deletes: [{ key: { id: 1 } }], cascade: [{ table: "orders" }, { table: "items" }] });
    expect(res.status).toBe(400);
    expect(res.error).toStartWith("Statement 1 of 3 failed: items are kept.");
    expect(query(path, "SELECT COUNT(*) AS n FROM orders")).toEqual([{ n: 3 }]);
  });
});

describe("changeset on a readonly connection", () => {
  it("is refused before anything runs, and the attempt is audited as blocked", async () => {
    const path = seed(PEOPLE);
    const id = await connect(path, true);
    const res = await apply(id, { table: "people", updates: [{ key: { id: 1 }, set: { name: "A" } }] });
    expect(res.status).toBe(403);
    expect(res.error).toContain("readonly");
    expect(query(path, "SELECT name FROM people WHERE id = 1")).toEqual([{ name: "a" }]);
    const logs = listQueryLogs({ connectionId: id });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: "blocked", operation: "update", sql: `UPDATE "people" SET "name" = 'A' WHERE "id" = 1;` });
  });

  it("still previews, since a preview writes nothing", async () => {
    const id = await connect(seed(PEOPLE), true);
    const res = await preview(id, { table: "people", deletes: [{ key: { id: 1 } }] });
    expect(res.status).toBe(200);
    expect(res.data.script).toBe(`DELETE FROM "people" WHERE "id" = 1;`);
  });
});

describe("the single-change endpoints, now changesets underneath", () => {
  it("edits a cell by the rowid the older SQLite viewer sends, on a table with a primary key", async () => {
    const path = seed(PEOPLE);
    const id = await connect(path);
    const res = await app().request(`/db/connections/${id}/cell`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "people", pkColumn: "rowid", pkValue: 2, column: "name", value: "B" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ updated: true });
    expect(query(path, "SELECT name FROM people WHERE id = 2")).toEqual([{ name: "B" }]);
  });

  it("answers 409 for a cell whose row no longer exists instead of claiming success", async () => {
    const id = await connect(seed(PEOPLE));
    const res = await app().request(`/db/connections/${id}/cell`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "people", pkColumn: "id", pkValue: 99, column: "name", value: "x" }),
    });
    expect(res.status).toBe(409);
  });

  it("inserts into a table whose name the old identifier check refused", async () => {
    const path = seed(`CREATE TABLE "order items" ("line no" INTEGER PRIMARY KEY, note TEXT);`);
    const id = await connect(path);
    const res = await app().request(`/db/connections/${id}/row`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table: "order items", values: { "line no": 1, note: "it's" } }),
    });
    expect(res.status).toBe(201);
    expect(query(path, `SELECT * FROM "order items"`)).toEqual([{ "line no": 1, note: "it's" }]);
  });

  it("deletes several rows by key, all or none", async () => {
    const path = seed(`
      CREATE TABLE memberships (org TEXT, user_id INTEGER, PRIMARY KEY (org, user_id));
      INSERT INTO memberships VALUES ('a', 1), ('a', 2), ('b', 1);
    `);
    const id = await connect(path);
    const res = await post<{ deleted: number }>(`/db/connections/${id}/rows/delete`, {
      table: "memberships", keys: [{ org: "a", user_id: 1 }, { org: "b", user_id: 1 }],
    });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ deleted: 2 });
    expect(query(path, "SELECT * FROM memberships")).toEqual([{ org: "a", user_id: 2 }]);
  });
});
