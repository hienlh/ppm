/**
 * The table editor's Save and the tree's table commands, end to end through
 * `structure/preview` and `structure/apply`. SQLite always runs; Postgres, MySQL and MariaDB run
 * when the URLs name disposable servers, e.g.
 *
 *   docker run --rm -d -p 127.0.0.1:25432:5432 -e POSTGRES_PASSWORD=x postgres:17
 *   docker run --rm -d -p 127.0.0.1:23306:3306 -e MYSQL_ROOT_PASSWORD=x mysql:8.4
 *   docker run --rm -d -p 127.0.0.1:23307:3306 -e MARIADB_ROOT_PASSWORD=x mariadb:11
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:25432/postgres \
 *   PPM_TEST_MYSQL_URL=mysql://root:x@127.0.0.1:23306 PPM_TEST_MARIADB_URL=mariadb://root:x@127.0.0.1:23307 \
 *     bun test tests/integration/db/structure-apply.test.ts
 *
 * Each server run works in a schema or database of its own and drops it at the end.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import mysql2 from "mysql2/promise";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { initAdapters } from "../../../src/services/database/init-adapters.ts";
import { installDbDriver } from "../../../src/services/database/drivers/db-driver-install.ts";
import { postgresService, readonlyPostgresService } from "../../../src/services/postgres.service.ts";
import { mysqlService } from "../../../src/services/mysql.service.ts";
import { databaseRoutes } from "../../../src/server/routes/database.ts";
import { closeAuditDb, getAuditDb } from "../../../src/services/query-audit/query-audit-db.ts";
import { listQueryLogs } from "../../../src/services/query-audit/query-audit.service.ts";
import type { DbObjectList, DbTableStructure } from "../../../src/shared/db-structure.ts";
import type { StructureChange, StructureFailure, StructurePreview } from "../../../src/shared/db-structure-change.ts";
import type { DbType, DialectName } from "../../../src/shared/db-types.ts";
import {
  baseColumnId, blankColumn, columnById, modelFromStructure, newTableModel, removeItem, upsertColumn, upsertItem, type TableModel, type TableModelColumn,
} from "../../../src/shared/db-table-model.ts";
import { copyingRunner } from "../../helpers/db-driver-offline-install.ts";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const tempDirs: string[] = [];
const originalPpmHome = process.env.PPM_HOME;

const app = () => new Hono().route("/db", databaseRoutes);

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T; error?: string }> {
  const res = await app().request(path, {
    method,
    headers: { "Content-Type": "application/json", "x-ppm-client": "web" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { data: T; error?: string };
  return { status: res.status, data: json.data, error: json.error };
}

async function createConnection(type: DbType, config: Record<string, unknown>, readonly = false): Promise<number> {
  const res = await call<{ id: number }>("POST", "/db/connections", { type, name: `sa-${type}-${readonly ? "ro" : "rw"}`, connectionConfig: { type, ...config } });
  if (res.status !== 201 && res.status !== 200) throw new Error(`create connection: ${res.status} ${res.error}`);
  if (!readonly) await call("PUT", `/db/connections/${res.data.id}`, { readonly: 0 });
  return res.data.id;
}

async function preview(id: number, change: StructureChange) {
  const res = await call<StructurePreview>("POST", `/db/connections/${id}/structure/preview`, { change });
  // The statements one by one are the script: what a failure's index counts is what the dialog showed.
  if (res.status === 200) expect(res.data.statements.map((s) => s.sql).join("\n")).toBe(res.data.sql);
  return res;
}
const apply = (id: number, change: StructureChange, opts: { allowRecreate?: boolean; sql?: string } = {}) =>
  call<StructureFailure & StructurePreview & { executionTimeMs: number }>("POST", `/db/connections/${id}/structure/apply`, { change, ...opts });

/** Preview, then apply what the preview showed — what the Save dialog's OK does. */
async function save(id: number, change: StructureChange, allowRecreate = false): Promise<StructurePreview> {
  const p = await preview(id, change);
  if (p.status !== 200) throw new Error(`preview: ${p.status} ${p.error}`);
  const a = await apply(id, change, { sql: p.data.sql, allowRecreate });
  if (a.status !== 200) throw new Error(`apply: ${a.status} ${a.error}\n${p.data.sql}`);
  return p.data;
}

async function structureOf(id: number, table: string, schema?: string | null): Promise<DbTableStructure> {
  const qs = new URLSearchParams({ table, ...(schema ? { schema } : {}) });
  const res = await call<DbTableStructure>("GET", `/db/connections/${id}/structure?${qs}`);
  if (res.status !== 200) throw new Error(`structure of ${table}: ${res.status} ${res.error}`);
  return res.data;
}

async function modelOf(id: number, dialect: DialectName, table: string, schema?: string | null): Promise<TableModel> {
  return modelFromStructure(await structureOf(id, table, schema), dialect);
}

const change = (m: TableModel, name: string, patch: Partial<TableModelColumn>) => upsertColumn(m, { ...columnById(m, baseColumnId(name))!, ...patch });

const structureLogs = () => listQueryLogs({ source: "structure" });

function isolatePpmHome(): void {
  const home = mkdtempSync(join(tmpdir(), "ppm-sa-home-"));
  tempDirs.push(home);
  process.env.PPM_HOME = home;
  closeAuditDb();
  _resetPpmDir();
}

beforeAll(async () => {
  initAdapters();
  if (process.env.PPM_TEST_MYSQL_URL || process.env.PPM_TEST_MARIADB_URL) await installDbDriver("mysql", { run: copyingRunner("mysql") });
});

afterAll(async () => {
  await postgresService.closeAll();
  await readonlyPostgresService.closeAll();
  await mysqlService.closeAll();
  closeAuditDb();
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows keeps sqlite handles briefly */ }
  }
});

describe("structure changes on SQLite", () => {
  let path = "";
  let id = 0;
  const raw = () => new Database(path);
  const rows = (sql: string) => {
    const db = raw();
    try { return db.query(sql).all(); } finally { db.close(); }
  };

  beforeEach(async () => {
    isolatePpmHome();
    setDb(openTestDb());
    getAuditDb();
    const dir = mkdtempSync(join(tmpdir(), "ppm-sa-target-"));
    tempDirs.push(dir);
    path = join(dir, "shop.db");
    const db = new Database(path);
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, age TEXT);
      CREATE INDEX users_name ON users (name);
      CREATE TABLE audit (msg TEXT);
      CREATE TRIGGER users_ins AFTER INSERT ON users BEGIN INSERT INTO audit VALUES ('new ' || NEW.name); END;
      CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id), note TEXT);
      INSERT INTO users (name, age) VALUES ('ann', '30'), ('bob', '41');
      INSERT INTO orders (user_id, note) VALUES (1, 'first'), (2, 'second'), (1, 'third');
    `);
    db.close();
    id = await createConnection("sqlite", { path });
  });

  it("renames a column in place, keeping its data", async () => {
    const base = await modelOf(id, "sqlite", "users");
    const req: StructureChange = { kind: "alter", base, current: change(base, "name", { name: "full_name" }) };
    const p = (await preview(id, req)).data;
    expect(p.sql).toBe(`ALTER TABLE "users" RENAME COLUMN "name" TO "full_name";`);
    expect(p.recreate).toBe(false);
    expect(p.transactional).toBe(true);
    // Through the server the way Bun.serve hands requests over, which lets the route lift the idle timeout.
    const timeouts: number[] = [];
    const res = await app().fetch(new Request("http://ppm/db/connections/" + id + "/structure/apply", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ change: req, sql: p.sql }),
    }), { timeout: (_req: Request, seconds: number) => timeouts.push(seconds) });
    expect(res.status).toBe(200);
    expect(timeouts).toEqual([0]);
    expect(structureLogs()[0]).toMatchObject({ status: "ok", operation: "other", sql: p.sql });
    expect(rows("SELECT id, full_name FROM users ORDER BY id")).toEqual([{ id: 1, full_name: "ann" }, { id: 2, full_name: "bob" }]);
    // The index went with it.
    expect(rows("SELECT name FROM pragma_index_info('users_name')")).toEqual([{ name: "full_name" }]);
  });

  it("rebuilds the table for a type change only with Allow recreate, and loses nothing", async () => {
    const base = await modelOf(id, "sqlite", "users");
    const req: StructureChange = { kind: "alter", base, current: change(base, "age", { type: "INTEGER" }) };
    const p = await preview(id, req);
    expect(p.data.recreate).toBe(true);
    expect(p.data.warnings[0]).toContain("age");
    // Outside the transaction, where SQLite honours them: the dialog reports them as run either way.
    expect(p.data.statements.filter((s) => s.phase)).toEqual([
      { sql: "PRAGMA foreign_keys = OFF;", phase: "before" },
      { sql: "PRAGMA foreign_keys = ON;", phase: "after" },
    ]);
    const refused = await apply(id, req, { sql: p.data.sql });
    expect(refused.status).toBe(400);
    expect(refused.error).toContain("Allow recreate");
    expect(rows("SELECT type FROM pragma_table_info('users') WHERE name = 'age'")).toEqual([{ type: "TEXT" }]);

    const ok = await apply(id, req, { sql: p.data.sql, allowRecreate: true });
    expect(ok.status).toBe(200);
    expect(rows("SELECT type FROM pragma_table_info('users') WHERE name = 'age'")).toEqual([{ type: "INTEGER" }]);
    expect(rows("SELECT id, name, age FROM users ORDER BY id")).toEqual([{ id: 1, name: "ann", age: 30 }, { id: 2, name: "bob", age: 41 }]);
    expect(rows("SELECT name FROM sqlite_schema WHERE type IN ('index', 'trigger') AND tbl_name = 'users' ORDER BY name")).toEqual([{ name: "users_ins" }, { name: "users_name" }]);
    // The child's key still names users — not the new_users the rows were copied through.
    expect(rows(`SELECT "table" FROM pragma_foreign_key_list('orders')`)).toEqual([{ table: "users" }]);
    expect(rows("PRAGMA foreign_key_check")).toEqual([]);
    // The trigger still fires, and AUTOINCREMENT carries on from where it was.
    const db = raw();
    db.exec("INSERT INTO users (name, age) VALUES ('cy', 7)");
    expect(db.query("SELECT max(id) AS id FROM users").get()).toEqual({ id: 3 });
    expect(db.query("SELECT count(*) AS n FROM audit WHERE msg = 'new cy'").get()).toEqual({ n: 1 });
    db.close();

    const [entry] = structureLogs();
    expect(entry).toMatchObject({ source: "structure", status: "ok", operation: "script", sql: p.data.sql });
    expect(JSON.parse(entry!.params_json!)).toMatchObject({ kind: "alter", table: "users", recreate: true });
  });

  it("leaves nothing applied when one statement fails", async () => {
    const base = await modelOf(id, "sqlite", "orders");
    let current = change(base, "note", { name: "memo" });
    // user_id holds 1 twice, so a unique index on it cannot be built.
    current = upsertItem(current, "indexes", {
      id: "n:ix", name: "orders_user_unique", unique: true, method: null, where: null,
      columns: [{ columnId: baseColumnId("user_id"), expression: null, descending: false }],
    });
    const req: StructureChange = { kind: "alter", base, current };
    const p = await preview(id, req);
    expect(p.data.sql.split("\n")).toEqual([
      `ALTER TABLE "orders" RENAME COLUMN "note" TO "memo";`,
      `CREATE UNIQUE INDEX "orders_user_unique" ON "orders" ("user_id");`,
    ]);
    const res = await apply(id, req, { sql: p.data.sql });
    expect(res.status).toBe(400);
    expect(res.data).toEqual({ statement: `CREATE UNIQUE INDEX "orders_user_unique" ON "orders" ("user_id")`, index: 1, applied: 0, total: 2 });
    expect(res.error).toStartWith("Statement 2 of 2 failed: UNIQUE constraint failed");
    expect(res.error).toEndWith("Nothing was saved.");
    expect(rows("SELECT name FROM pragma_table_info('orders') ORDER BY cid")).toEqual([{ name: "id" }, { name: "user_id" }, { name: "note" }]);
    expect(structureLogs()[0]).toMatchObject({ status: "error", sql: p.data.sql });
  });

  it("refuses a base read before the table changed, and a script other than the one shown", async () => {
    const base = await modelOf(id, "sqlite", "users");
    const req: StructureChange = { kind: "alter", base, current: change(base, "name", { name: "full_name" }) };
    const p = await preview(id, req);
    const shown = await apply(id, req, { sql: "ALTER TABLE users DROP COLUMN name" });
    expect(shown.status).toBe(409);
    expect(shown.data.sql).toBe(p.data.sql);

    const db = raw();
    db.exec("ALTER TABLE users ADD COLUMN email TEXT");
    db.close();
    const stale = await apply(id, req, { sql: p.data.sql });
    expect(stale.status).toBe(409);
    expect(stale.error).toContain("has changed since the editor read it");
    expect(rows("SELECT name FROM pragma_table_info('users') WHERE name = 'name'")).toEqual([{ name: "name" }]);
  });

  it("refuses both calls on a readonly connection, and audits the refused apply as blocked", async () => {
    const ro = await createConnection("sqlite", { path }, true);
    const base = await modelOf(ro, "sqlite", "users");
    const req: StructureChange = { kind: "alter", base, current: change(base, "name", { name: "full_name" }) };
    expect((await preview(ro, req)).status).toBe(403);
    const res = await apply(ro, req);
    expect(res.status).toBe(403);
    expect(res.error).toContain("readonly");
    const [entry] = structureLogs();
    expect(entry).toMatchObject({ source: "structure", status: "blocked", sql: `ALTER TABLE "users" RENAME COLUMN "name" TO "full_name";` });
    expect(rows("SELECT name FROM pragma_table_info('users') WHERE name = 'name'")).toEqual([{ name: "name" }]);
    expect((await apply(ro, { kind: "drop-table", schema: null, table: "orders" })).status).toBe(403);
    expect(rows("SELECT count(*) AS n FROM orders")).toEqual([{ n: 3 }]);
  });

  it("creates a new table with its key and a foreign key inside CREATE TABLE", async () => {
    let model = { ...newTableModel(null), name: "payments" };
    model = upsertColumn(model, { ...blankColumn("n:3", "order_id"), type: "INTEGER" });
    model = upsertItem(model, "foreignKeys", {
      id: "n:4", name: null, columns: ["n:3"], refSchema: null, refTable: "orders", refColumns: ["id"], onUpdate: null, onDelete: "CASCADE",
    });
    const p = await save(id, { kind: "create", current: model });
    expect(p.sql).toBe([
      `CREATE TABLE "payments" (`,
      // Only a column declared INTEGER is the rowid, which AUTOINCREMENT needs.
      `  "id" INTEGER PRIMARY KEY AUTOINCREMENT,`,
      `  "order_id" INTEGER,`,
      `  FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE`,
      `);`,
    ].join("\n"));
    const objects = await call<DbObjectList>("GET", `/db/connections/${id}/objects`);
    expect(objects.data.objects.some((o) => o.name === "payments" && o.kind === "table")).toBe(true);
    const again = await preview(id, { kind: "create", current: model });
    expect(again.status).toBe(409);
  });

  it("runs the tree's column commands from the live table", async () => {
    await save(id, { kind: "rename-column", schema: null, table: "orders", column: "note", newName: "memo" });
    expect(rows("SELECT memo FROM orders ORDER BY id")).toEqual([{ memo: "first" }, { memo: "second" }, { memo: "third" }]);
    const p = await save(id, { kind: "drop-column", schema: null, table: "orders", column: "memo" });
    expect(p.sql).toBe(`ALTER TABLE "orders" DROP COLUMN "memo";`);
    expect(rows("SELECT name FROM pragma_table_info('orders') ORDER BY cid")).toEqual([{ name: "id" }, { name: "user_id" }]);
    expect((await preview(id, { kind: "drop-column", schema: null, table: "orders", column: "nope" })).status).toBe(404);
    const taken = await preview(id, { kind: "rename-column", schema: null, table: "orders", column: "user_id", newName: "ID" });
    expect(taken.status).toBe(400);
    expect(taken.error).toContain("There is already a column named");
  });

  it("drops, truncates, renames and backs up a table", async () => {
    const refused = await preview(id, { kind: "drop-table", schema: null, table: "users" });
    expect(refused.status).toBe(400);
    expect(refused.error).toContain("orders has a foreign key onto users");

    // A NO ACTION key refuses the delete a truncate is on SQLite, and nothing is lost.
    const truncate = await apply(id, { kind: "truncate-table", schema: null, table: "users" });
    expect(truncate.status).toBe(400);
    expect(truncate.error).toContain("FOREIGN KEY constraint failed");
    expect(rows("SELECT count(*) AS n FROM users")).toEqual([{ n: 2 }]);

    const at = "_users_2026-10-01-13-05-09";
    await save(id, { kind: "backup-table", schema: null, table: "users", newName: at });
    expect(rows(`SELECT id, name, age FROM "${at}" ORDER BY id`)).toEqual([{ id: 1, name: "ann", age: "30" }, { id: 2, name: "bob", age: "41" }]);
    // A copy of the rows, not of what ties the table to anything: no index, no AUTOINCREMENT.
    expect(rows(`SELECT name FROM sqlite_schema WHERE tbl_name = '${at}' AND type <> 'table'`)).toEqual([]);
    expect(rows(`SELECT sql FROM sqlite_schema WHERE name = '${at}'`)[0]).toEqual({ sql: expect.not.stringContaining("AUTOINCREMENT") });

    await save(id, { kind: "rename-table", schema: null, table: "orders", newName: "purchases" });
    expect(rows(`SELECT "table" FROM pragma_foreign_key_list('purchases')`)).toEqual([{ table: "users" }]);
    expect((await preview(id, { kind: "rename-table", schema: null, table: "purchases", newName: "users" })).status).toBe(409);

    await save(id, { kind: "drop-table", schema: null, table: "purchases" });
    const p = await save(id, { kind: "truncate-table", schema: null, table: "users" });
    expect(p.sql).toBe(`DELETE FROM "users";`);
    expect(rows("SELECT count(*) AS n FROM users")).toEqual([{ n: 0 }]);
    expect(rows("SELECT name FROM sqlite_schema WHERE name = 'purchases'")).toEqual([]);
  });

  it("warns when a truncate would run another table's ON DELETE action", async () => {
    const db = raw();
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id) ON DELETE CASCADE)");
    db.close();
    const p = await preview(id, { kind: "truncate-table", schema: null, table: "users" });
    expect(p.data.warnings).toEqual(["Also deletes the rows of notes that point at users (its foreign key on user_id is ON DELETE CASCADE)"]);
  });

  it("answers 400 for a request that is not a change, and 404 for a table that is not there", async () => {
    expect((await call("POST", `/db/connections/${id}/structure/preview`, { change: { kind: "shrink" } })).status).toBe(400);
    const bad = await call("POST", `/db/connections/${id}/structure/preview`, { change: { kind: "create", current: { name: "x", columns: [{ id: "a", name: "a", type: 5 }] } } });
    expect(bad.status).toBe(400);
    expect(bad.error).toBe("change.current.columns[0].type must be a string");
    const model = newTableModel(null);
    const twins = await preview(id, { kind: "create", current: { ...model, columns: [model.columns[0]!, { ...model.columns[0]!, name: "other" }] } });
    expect(twins.status).toBe(400);
    expect(twins.error).toBe("change.current has two items with the id n:1");
    expect((await preview(id, { kind: "drop-table", schema: null, table: "nope" })).status).toBe(404);
    const base = await modelOf(id, "sqlite", "users");
    const renamed = await preview(id, { kind: "alter", base, current: { ...base, name: "people" } });
    expect(renamed.status).toBe(400);
    expect(renamed.error).toContain("Rename table");
    const empty = await apply(id, { kind: "alter", base, current: base });
    expect(empty).toMatchObject({ status: 200, data: { executionTimeMs: 0 } });
    expect(structureLogs()).toEqual([]);
  });
});

const PG_URL = process.env.PPM_TEST_PG_URL;

describe.skipIf(!PG_URL)("structure changes on Postgres", () => {
  const S = `ppm_sa_${RUN}`;
  const admin = PG_URL ? postgres(PG_URL, { max: 1, onnotice: () => {} }) : null;
  let id = 0;
  let ro = 0;
  const q = async (sql: string) => [...(await admin!.unsafe(sql))];

  beforeAll(async () => {
    isolatePpmHome();
    setDb(openTestDb());
    getAuditDb();
    id = await createConnection("postgres", { connectionString: PG_URL });
    ro = await createConnection("postgres", { connectionString: PG_URL }, true);
  });

  beforeEach(async () => {
    getAuditDb().exec("DELETE FROM query_log");
    await admin!.unsafe(`
      DROP SCHEMA IF EXISTS ${S} CASCADE;
      CREATE SCHEMA ${S};
      CREATE TABLE ${S}.users (id serial PRIMARY KEY, name text, nick text);
      INSERT INTO ${S}.users (name, nick) VALUES ('ann', NULL), ('bob', 'b');
      CREATE TABLE ${S}.orders (id serial PRIMARY KEY, user_id int REFERENCES ${S}.users (id), note text);
      INSERT INTO ${S}.orders (user_id, note) VALUES (1, 'first'), (2, 'second');
    `);
  });

  afterAll(async () => {
    await postgresService.closeAll();
    await readonlyPostgresService.closeAll();
    await admin?.unsafe(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await admin?.end();
  });

  it("renames a column, keeping its data", async () => {
    const base = await modelOf(id, "postgres", "users", S);
    const p = await save(id, { kind: "alter", base, current: change(base, "name", { name: "full_name" }) });
    expect(p.sql).toBe(`ALTER TABLE "${S}"."users" RENAME COLUMN "name" TO "full_name";`);
    expect(await q(`SELECT full_name FROM ${S}.users ORDER BY id`)).toEqual([{ full_name: "ann" }, { full_name: "bob" }]);
  });

  it("makes a column holding NULLs NOT NULL by giving those rows the default first", async () => {
    const base = await modelOf(id, "postgres", "users", S);
    const p = await save(id, { kind: "alter", base, current: change(base, "nick", { notNull: true, defaultValue: "'none'" }) });
    expect(p.sql.split("\n")).toEqual([
      `ALTER TABLE "${S}"."users" ALTER COLUMN "nick" SET DEFAULT 'none';`,
      `UPDATE "${S}"."users" SET "nick" = 'none' WHERE "nick" IS NULL;`,
      `ALTER TABLE "${S}"."users" ALTER COLUMN "nick" SET NOT NULL;`,
    ]);
    expect(await q(`SELECT nick FROM ${S}.users ORDER BY id`)).toEqual([{ nick: "none" }, { nick: "b" }]);
  });

  it("leaves nothing applied when one statement fails", async () => {
    const base = await modelOf(id, "postgres", "orders", S);
    const current = upsertColumn(change(base, "note", { name: "memo" }), { ...blankColumn("n:9", "qty"), type: "integer", notNull: true });
    const req: StructureChange = { kind: "alter", base, current };
    const p = await preview(id, req);
    expect(p.data.warnings).toEqual(["qty is NOT NULL with no default, so adding it fails if orders has rows"]);
    const res = await apply(id, req, { sql: p.data.sql });
    expect(res.status).toBe(400);
    expect(res.data).toMatchObject({ index: 1, applied: 0, total: 2 });
    expect(res.error).toContain("contains null values");
    expect(await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = '${S}' AND table_name = 'orders' ORDER BY ordinal_position`))
      .toEqual([{ column_name: "id" }, { column_name: "user_id" }, { column_name: "note" }]);
  });

  it("drops a table after the keys other tables hold on it, keeping their rows", async () => {
    const p = await save(id, { kind: "drop-table", schema: S, table: "users" });
    expect(p.sql.split("\n")).toEqual([`ALTER TABLE "${S}"."orders" DROP CONSTRAINT "orders_user_id_fkey";`, `DROP TABLE "${S}"."users";`]);
    expect(p.warnings).toEqual([`Drops the foreign key orders_user_id_fkey of ${S}.orders, which points at users`]);
    expect(await q(`SELECT count(*)::int AS n FROM ${S}.orders`)).toEqual([{ n: 2 }]);
    expect(await q(`SELECT to_regclass('${S}.users') AS r`)).toEqual([{ r: null }]);
  });

  it("creates a new table, backs one up and renames one", async () => {
    await save(id, { kind: "create", current: { ...newTableModel(S), name: "tags" } });
    expect(await q(`SELECT column_default FROM information_schema.columns WHERE table_schema = '${S}' AND table_name = 'tags'`))
      .toEqual([{ column_default: `nextval('${S}.tags_id_seq'::regclass)` }]);
    const at = "_users_2026-10-01-13-05-09";
    await save(id, { kind: "backup-table", schema: S, table: "users", newName: at });
    expect(await q(`SELECT id, name, nick FROM ${S}."${at}" ORDER BY id`)).toEqual([{ id: 1, name: "ann", nick: null }, { id: 2, name: "bob", nick: "b" }]);
    // The copy does not share the original's sequence.
    expect(await q(`SELECT column_default FROM information_schema.columns WHERE table_schema = '${S}' AND table_name = '${at}' AND column_name = 'id'`))
      .toEqual([{ column_default: null }]);
    await save(id, { kind: "rename-table", schema: S, table: "orders", newName: "purchases" });
    expect(await q(`SELECT count(*)::int AS n FROM ${S}.purchases`)).toEqual([{ n: 2 }]);
  });

  it("refuses a readonly connection and audits the refusal", async () => {
    const res = await apply(ro, { kind: "drop-table", schema: S, table: "orders" });
    expect(res.status).toBe(403);
    expect(structureLogs()[0]).toMatchObject({ status: "blocked", sql: `DROP TABLE "${S}"."orders";` });
    expect(await q(`SELECT count(*)::int AS n FROM ${S}.orders`)).toEqual([{ n: 2 }]);
  });
});

for (const engine of [
  { type: "mysql" as const, url: process.env.PPM_TEST_MYSQL_URL },
  { type: "mariadb" as const, url: process.env.PPM_TEST_MARIADB_URL },
]) {
  describe.skipIf(!engine.url)(`structure changes on ${engine.type}`, () => {
    const D = `ppm_sa_${engine.type}_${RUN}`;
    let admin: mysql2.Connection;
    let id = 0;
    const q = async (sql: string) => (await admin.query(sql))[0] as Record<string, unknown>[];

    beforeAll(async () => {
      isolatePpmHome();
      setDb(openTestDb());
      getAuditDb();
      admin = await mysql2.createConnection({ uri: engine.url!.replace(/^mariadb:/, "mysql:"), multipleStatements: true });
      const url = `${engine.url!.replace(/\/$/, "")}/${D}`;
      await admin.query(`CREATE DATABASE ${D}`);
      id = await createConnection(engine.type, { connectionString: url });
    });

    beforeEach(async () => {
      await admin.query(`
        USE ${D};
        DROP TABLE IF EXISTS users;
        CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(40), nick VARCHAR(20), KEY users_name (name)) COMMENT='People';
        INSERT INTO users (name, nick) VALUES ('ann', NULL), ('bob', 'x'), ('cy', 'x');
      `);
    });

    afterAll(async () => {
      await mysqlService.closeAll();
      await admin?.query(`DROP DATABASE IF EXISTS ${D}`);
      await admin?.end();
    });

    it("renames a column, keeping its data", async () => {
      const base = await modelOf(id, "mysql", "users", D);
      const p = await save(id, { kind: "alter", base, current: change(base, "name", { name: "full_name" }) });
      expect(p.sql).toBe(`ALTER TABLE \`${D}\`.\`users\` RENAME COLUMN \`name\` TO \`full_name\`;`);
      expect(p.transactional).toBe(false);
      expect(await q(`SELECT full_name FROM ${D}.users ORDER BY id`)).toEqual([{ full_name: "ann" }, { full_name: "bob" }, { full_name: "cy" }]);
    });

    it("says which statements ran when one fails: the first stays, the third never runs", async () => {
      const base = await modelOf(id, "mysql", "users", D);
      let current = removeItem(base, "indexes", "ix:users_name");
      // nick holds 'x' twice.
      current = upsertItem(current, "uniques", { id: "n:uq", name: null, columns: [baseColumnId("nick")] });
      current = { ...current, comment: "Humans" };
      const req: StructureChange = { kind: "alter", base, current };
      const p = await preview(id, req);
      expect(p.data.sql.split("\n")).toEqual([
        `DROP INDEX \`users_name\` ON \`${D}\`.\`users\`;`,
        `ALTER TABLE \`${D}\`.\`users\` ADD CONSTRAINT \`UQ_users_nick\` UNIQUE (\`nick\`);`,
        `ALTER TABLE \`${D}\`.\`users\` COMMENT='Humans';`,
      ]);
      const res = await apply(id, req, { sql: p.data.sql });
      expect(res.status).toBe(400);
      expect(res.data).toMatchObject({ index: 1, applied: 1, total: 3 });
      expect(res.error).toContain("Statement 2 of 3 failed");
      expect(res.error).toContain("The statement before it stays applied, since MySQL commits each DDL statement");
      expect(res.error).toContain("the one after it did not run");
      expect(await q(`SELECT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = '${D}' AND TABLE_NAME = 'users' AND INDEX_NAME = 'users_name'`)).toEqual([]);
      expect(await q(`SELECT TABLE_COMMENT AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${D}' AND TABLE_NAME = 'users'`)).toEqual([{ c: "People" }]);
    });

    it("makes a column holding NULLs NOT NULL by giving those rows the default first", async () => {
      const base = await modelOf(id, "mysql", "users", D);
      const p = await save(id, { kind: "alter", base, current: change(base, "nick", { notNull: true, defaultValue: "'none'" }) });
      expect(p.sql.split("\n")[0]).toBe(`UPDATE \`${D}\`.\`users\` SET \`nick\` = 'none' WHERE \`nick\` IS NULL;`);
      expect(await q(`SELECT nick FROM ${D}.users ORDER BY id`)).toEqual([{ nick: "none" }, { nick: "x" }, { nick: "x" }]);
    });

    it("creates a new table", async () => {
      await save(id, { kind: "create", current: { ...newTableModel(D), name: "tags" } });
      expect(await q(`SELECT EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${D}' AND TABLE_NAME = 'tags'`)).toEqual([{ extra: "auto_increment" }]);
    });
  });
}
