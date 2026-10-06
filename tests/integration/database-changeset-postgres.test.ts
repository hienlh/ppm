/**
 * Changesets and the structure reader against a real Postgres. Runs only when
 * `PPM_TEST_PG_URL` names a disposable database, e.g.
 *
 *   docker run --rm -d -p 25432:5432 -e POSTGRES_PASSWORD=x postgres:17
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:25432/postgres bun test tests/integration/database-changeset-postgres.test.ts
 *
 * Everything it creates lives in one schema named after this run and is dropped at the end.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import postgres from "postgres";
import { openTestDb, setDb } from "../../src/services/db.service.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { postgresService, readonlyPostgresService } from "../../src/services/postgres.service.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import type { ChangesetApplyResult, ChangesetFailure, ChangesetPreview } from "../../src/shared/db-changeset.ts";
import type { DbObjectList, DbTableStructure } from "../../src/shared/db-structure.ts";

const PG_URL = process.env.PPM_TEST_PG_URL;
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const S = `ppm_cs_${RUN}`;

const app = () => new Hono().route("/db", databaseRoutes);
let connId = 0;
let readonlyId = 0;

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T; error?: string }> {
  const res = await app().request(path, {
    method,
    headers: { "Content-Type": "application/json", "x-ppm-client": "web" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as { data: T; error?: string };
  return { status: res.status, data: json.data, error: json.error };
}
const apply = (body: unknown, id = connId) => call<ChangesetApplyResult & ChangesetFailure>("POST", `/db/connections/${id}/changeset/apply`, { schema: S, ...(body as object) });
const preview = (body: unknown) => call<ChangesetPreview>("POST", `/db/connections/${connId}/changeset/preview`, { schema: S, ...(body as object) });

async function createConnection(name: string, writable: boolean): Promise<number> {
  const res = await call<{ id: number }>("POST", "/db/connections", {
    type: "postgres", name, connectionConfig: { type: "postgres", connectionString: PG_URL },
  });
  if (writable) await call("PUT", `/db/connections/${res.data.id}`, { readonly: 0 });
  return res.data.id;
}

describe.skipIf(!PG_URL)("changeset on Postgres", () => {
  const admin = PG_URL ? postgres(PG_URL, { max: 1, onnotice: () => {} }) : null;
  const rows = (sql: string) => admin!.unsafe(sql) as Promise<Record<string, unknown>[]>;

  beforeAll(async () => {
    initAdapters();
    setDb(openTestDb());
    connId = await createConnection("cs-pg", true);
    readonlyId = await createConnection("cs-pg-ro", false);
  });

  beforeEach(async () => {
    await admin!.unsafe(`
      DROP SCHEMA IF EXISTS ${S} CASCADE;
      CREATE SCHEMA ${S};
      CREATE TABLE ${S}.people (
        id int PRIMARY KEY, name text NOT NULL, age int, meta jsonb, active boolean, score double precision
      );
      INSERT INTO ${S}.people VALUES (1, 'a', 10, '{"k": 1}', true, 0.1), (2, 'b', 20, NULL, false, NULL), (3, 'c', 30, NULL, NULL, NULL);
      CREATE TABLE ${S}.memberships (org text, user_id int, role text, PRIMARY KEY (org, user_id));
      INSERT INTO ${S}.memberships VALUES ('a', 1, 'r1'), ('a', 2, 'r2'), ('b', 1, 'r3');
      CREATE TABLE ${S}.big (id int8 PRIMARY KEY, v text);
      INSERT INTO ${S}.big VALUES (9007199254740993, 'x'), (9007199254740992, 'y');
      CREATE TABLE ${S}.users (id int PRIMARY KEY);
      CREATE TABLE ${S}.orders (id int PRIMARY KEY, user_id int REFERENCES ${S}.users (id));
      CREATE TABLE ${S}.items (id int PRIMARY KEY, order_id int REFERENCES ${S}.orders (id) ON DELETE CASCADE);
      INSERT INTO ${S}.users VALUES (1), (2);
      INSERT INTO ${S}.orders VALUES (10, 1), (11, 1), (20, 2);
      INSERT INTO ${S}.items VALUES (100, 10), (101, 11), (200, 20);
      CREATE TABLE ${S}.parents (id int PRIMARY KEY);
      CREATE TABLE ${S}.children (id int PRIMARY KEY, parent_id int REFERENCES ${S}.parents (id) DEFERRABLE INITIALLY DEFERRED);
    `);
  });

  afterAll(async () => {
    await admin?.unsafe(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await admin?.end();
    await postgresService.closeAll();
    await readonlyPostgresService.closeAll();
  });

  it("saves nothing when a new row breaks NOT NULL, and names that statement", async () => {
    const res = await apply({
      table: "people",
      updates: [
        { key: { id: 1 }, set: { name: "A" } },
        { key: { id: 2 }, set: { age: 21 } },
        { key: { id: 3 }, set: { name: "C" } },
      ],
      inserts: [{ id: 4, age: 40 }],
    });
    expect(res.status).toBe(400);
    expect(res.error).toStartWith(`Statement 1 of 4 failed: null value in column "name" of relation "people" violates not-null constraint. Nothing was saved.`);
    expect(res.data).toMatchObject({ statementIndex: 0, statementCount: 4, sql: `INSERT INTO "${S}"."people" ("id", "age") VALUES (4, 40)` });
    expect(await rows(`SELECT id, name, age FROM ${S}.people ORDER BY id`)).toEqual([
      { id: 1, name: "a", age: 10 }, { id: 2, name: "b", age: 20 }, { id: 3, name: "c", age: 30 },
    ]);
  });

  it("rolls back what already ran when a later statement fails", async () => {
    const res = await apply({
      table: "people",
      inserts: [{ id: 4, name: "d" }],
      updates: [{ key: { id: 1 }, set: { name: "A" } }, { key: { id: 2 }, set: { age: 21 } }, { key: { id: 3 }, set: { name: null } }],
    });
    expect(res.status).toBe(400);
    expect(res.error).toStartWith("Statement 4 of 4 failed:");
    expect(await rows(`SELECT id, name, age FROM ${S}.people ORDER BY id`)).toEqual([
      { id: 1, name: "a", age: 10 }, { id: 2, name: "b", age: 20 }, { id: 3, name: "c", age: 30 },
    ]);
  });

  it("writes JSON as JSON and a boolean typed as text as that boolean", async () => {
    const res = await apply({
      table: "people",
      inserts: [{ id: 5, name: "e", meta: { b: [1, 2] }, active: "true" }],
      updates: [{ key: { id: 2 }, set: { meta: '{"typed": "as text"}', active: "false" } }, { key: { id: 3 }, set: { active: "true" } }],
    });
    expect(res.status).toBe(200);
    expect(await rows(`SELECT id, jsonb_typeof(meta) AS t, meta, active FROM ${S}.people WHERE id IN (2, 3, 5) ORDER BY id`)).toEqual([
      { id: 2, t: "object", meta: { typed: "as text" }, active: false },
      { id: 3, t: null, meta: null, active: true },
      { id: 5, t: "object", meta: { b: [1, 2] }, active: true },
    ]);
  });

  it("edits and deletes exactly one row of a table keyed by two columns", async () => {
    const res = await apply({
      table: "memberships",
      updates: [{ key: { org: "a", user_id: 1 }, set: { role: "admin" } }],
      deletes: [{ key: { org: "b", user_id: 1 } }],
    });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ updated: 1, deleted: 1 });
    expect(await rows(`SELECT * FROM ${S}.memberships ORDER BY org, user_id`)).toEqual([
      { org: "a", user_id: 1, role: "admin" }, { org: "a", user_id: 2, role: "r2" },
    ]);
  });

  it("refuses a key that matches several rows", async () => {
    const res = await apply({ table: "memberships", updates: [{ key: { user_id: 1 }, set: { role: "x" } }] });
    expect(res.status).toBe(409);
    expect(res.data.affected).toBe(2);
    expect(await rows(`SELECT count(*)::int AS n FROM ${S}.memberships WHERE role = 'x'`)).toEqual([{ n: 0 }]);
  });

  it("addresses a bigint key past 2^53 exactly", async () => {
    const res = await apply({ table: "big", updates: [{ key: { id: "9007199254740993" }, set: { v: "changed" } }] });
    expect(res.status).toBe(200);
    expect(await rows(`SELECT id::text, v FROM ${S}.big ORDER BY id`)).toEqual([
      { id: "9007199254740992", v: "y" }, { id: "9007199254740993", v: "changed" },
    ]);
  });

  it("refuses to overwrite a value someone else changed, and saves one they did not touch", async () => {
    await admin!.unsafe(`UPDATE ${S}.people SET name = 'z', age = 99 WHERE id = 1`);
    const stale = await apply({ table: "people", updates: [{ key: { id: 1 }, set: { name: "A" }, original: { name: "a" } }] });
    expect(stale.status).toBe(409);
    expect(stale.error).toContain("changed or deleted by someone else");
    expect(await rows(`SELECT name FROM ${S}.people WHERE id = 1`)).toEqual([{ name: "z" }]);

    const fresh = await apply({ table: "people", updates: [{ key: { id: 1 }, set: { name: "A" }, original: { name: "z", age: 10 } }] });
    expect(fresh.status).toBe(200);
  });

  it("checks a NULL original too", async () => {
    await admin!.unsafe(`UPDATE ${S}.people SET age = 5 WHERE id = 3`);
    const res = await apply({ table: "people", updates: [{ key: { id: 3 }, set: { age: 31 }, original: { age: null } }] });
    expect(res.status).toBe(409);
  });

  it("previews the tables pointing at a deleted row, and deletes the ticked ones first", async () => {
    const p = await preview({ table: "users", deletes: [{ key: { id: 1 } }] });
    expect(p.status).toBe(200);
    expect(p.data.script).toBe(`DELETE FROM "${S}"."users" WHERE "id" = 1;`);
    expect(p.data.references.map((r) => [r.table, r.paths, r.cascadesInDb])).toEqual([
      ["items", [["items", "orders", "users"]], false],
      ["orders", [["orders", "users"]], false],
    ]);

    const refused = await apply({ table: "users", deletes: [{ key: { id: 1 } }] });
    expect(refused.status).toBe(400);
    expect(refused.error).toContain(`violates foreign key constraint`);

    // Ticking orders is enough: items follow it by their own ON DELETE CASCADE.
    const res = await apply({ table: "users", deletes: [{ key: { id: 1 } }], cascade: [{ table: "orders" }] });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ deleted: 1, cascaded: 2 });
    expect(await rows(`SELECT id FROM ${S}.users`)).toEqual([{ id: 2 }]);
    expect(await rows(`SELECT id FROM ${S}.items`)).toEqual([{ id: 200 }]);
  });

  it("blames the commit for a deferred key, with nothing saved", async () => {
    const res = await apply({ table: "children", inserts: [{ id: 1, parent_id: 99 }] });
    expect(res.status).toBe(400);
    expect(res.error).toStartWith(`The commit failed: insert or update on table "children" violates foreign key constraint`);
    expect(res.error).toEndWith("Nothing was saved.");
    expect(res.data).toEqual({ statementCount: 1 });
    expect(await rows(`SELECT count(*)::int AS n FROM ${S}.children`)).toEqual([{ n: 0 }]);
  });

  it("refuses a readonly connection before anything runs", async () => {
    const res = await apply({ table: "people", updates: [{ key: { id: 1 }, set: { name: "A" } }] }, readonlyId);
    expect(res.status).toBe(403);
    expect(await rows(`SELECT name FROM ${S}.people WHERE id = 1`)).toEqual([{ name: "a" }]);
  });

  it("keeps the single-cell endpoint working, and says when its row is gone", async () => {
    const ok = await call<{ updated: boolean }>("PUT", `/db/connections/${connId}/cell`, {
      table: "people", schema: S, pkColumn: "id", pkValue: 2, column: "meta", value: { via: "cell" },
    });
    expect(ok).toMatchObject({ status: 200, data: { updated: true } });
    expect(await rows(`SELECT meta FROM ${S}.people WHERE id = 2`)).toEqual([{ meta: { via: "cell" } }]);
    const gone = await call("PUT", `/db/connections/${connId}/cell`, { table: "people", schema: S, pkColumn: "id", pkValue: 42, column: "name", value: "x" });
    expect(gone.status).toBe(409);
  });
});

describe.skipIf(!PG_URL)("structure reader on Postgres", () => {
  const admin = PG_URL ? postgres(PG_URL, { max: 1, onnotice: () => {} }) : null;
  const T = `ppm_an_${RUN}`;

  beforeAll(async () => {
    initAdapters();
    setDb(openTestDb());
    connId = await createConnection("an-pg", false);
    await admin!.unsafe(`
      CREATE SCHEMA ${T};
      CREATE TABLE ${T}.orgs (region text, code text, PRIMARY KEY (region, code));
      CREATE TABLE ${T}.accounts (
        id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        serial_no serial,
        email varchar(200) NOT NULL,
        region text, code text,
        balance numeric(12, 2) DEFAULT 0 CHECK (balance >= 0),
        email_lower text GENERATED ALWAYS AS (lower(email)) STORED,
        tags text[],
        CONSTRAINT accounts_email_key UNIQUE (email),
        CONSTRAINT accounts_org_fk FOREIGN KEY (region, code) REFERENCES ${T}.orgs (region, code) ON DELETE SET NULL ON UPDATE CASCADE
      );
      COMMENT ON TABLE ${T}.accounts IS 'people who pay';
      COMMENT ON COLUMN ${T}.accounts.email IS 'login';
      CREATE INDEX accounts_big ON ${T}.accounts (balance) WHERE balance > 1000;
      CREATE INDEX accounts_tags ON ${T}.accounts USING gin (tags);
      CREATE INDEX accounts_lower ON ${T}.accounts (lower(email));
      CREATE VIEW ${T}.rich AS SELECT * FROM ${T}.accounts WHERE balance > 1000;
      CREATE VIEW ${T}.emails AS SELECT email FROM ${T}.accounts;
      CREATE MATERIALIZED VIEW ${T}.totals AS SELECT region, sum(balance) AS total FROM ${T}.accounts GROUP BY region;
      CREATE SEQUENCE ${T}.tickets;
      CREATE FUNCTION ${T}.add(a int, b int) RETURNS int LANGUAGE sql AS $$ SELECT a + b $$;
      CREATE FUNCTION ${T}.add(a text, b text) RETURNS text LANGUAGE sql AS $$ SELECT a || b $$;
      CREATE FUNCTION ${T}.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE PROCEDURE ${T}.reset() LANGUAGE sql AS $$ SELECT 1 $$;
      CREATE AGGREGATE ${T}.total_of(int) (SFUNC = int4pl, STYPE = int);
      CREATE TRIGGER accounts_touch BEFORE UPDATE ON ${T}.accounts FOR EACH ROW EXECUTE FUNCTION ${T}.touch();
    `);
  });

  afterAll(async () => {
    await admin?.unsafe(`DROP SCHEMA IF EXISTS ${T} CASCADE`);
    await admin?.end();
    await postgresService.closeAll();
    await readonlyPostgresService.closeAll();
  });

  it("lists every object of a schema, by kind, with overloads told apart", async () => {
    const res = await call<DbObjectList>("GET", `/db/connections/${connId}/objects`);
    expect(res.status).toBe(200);
    expect(res.data.schemas).toContain(T);
    const mine = res.data.objects.filter((o) => o.schema === T);
    const byKind = (kind: string) => mine.filter((o) => o.kind === kind).map((o) => o.args === undefined ? o.name : `${o.name}(${o.args})`).sort();
    expect(byKind("table")).toEqual(["accounts", "orgs"]);
    expect(byKind("view")).toEqual(["emails", "rich"]);
    expect(byKind("matview")).toEqual(["totals"]);
    // The aggregate is left out; the identity and serial columns bring sequences of their own.
    expect(byKind("function")).toEqual(["add(a integer, b integer)", "add(a text, b text)", "touch()"]);
    expect(byKind("procedure")).toEqual(["reset()"]);
    expect(byKind("sequence")).toEqual(["accounts_id_seq", "accounts_serial_no_seq", "tickets"]);
    expect(mine.filter((o) => o.kind === "trigger")).toEqual([{ schema: T, name: "accounts_touch", kind: "trigger", table: "accounts" }]);
  });

  it("describes a table in full", async () => {
    const res = await call<DbTableStructure>("GET", `/db/connections/${connId}/structure?schema=${T}&table=accounts`);
    expect(res.status).toBe(200);
    const s = res.data;
    expect(s).toMatchObject({ schema: T, name: "accounts", kind: "table", comment: "people who pay", rowKey: ["id"], rowKeyIsRowid: false });
    const col = (name: string) => s.columns.find((c) => c.name === name);
    expect(col("id")).toMatchObject({ type: "integer", nullable: false, autoIncrement: true, generated: false });
    expect(col("serial_no")).toMatchObject({ autoIncrement: true, defaultValue: `nextval('${T}.accounts_serial_no_seq'::regclass)` });
    expect(col("email")).toMatchObject({ type: "character varying(200)", nullable: false, comment: "login", autoIncrement: false });
    expect(col("balance")).toMatchObject({ type: "numeric(12,2)", defaultValue: "0" });
    expect(col("email_lower")).toMatchObject({ generated: true, defaultValue: null });
    expect(col("tags")!.type).toBe("text[]");
    expect(s.primaryKey).toEqual({ name: "accounts_pkey", columns: ["id"] });
    expect(s.uniques).toEqual([{ name: "accounts_email_key", columns: ["email"] }]);
    expect(s.checks).toEqual([{ name: "accounts_balance_check", expression: "balance >= 0::numeric" }]);
    expect(s.foreignKeys).toEqual([{
      name: "accounts_org_fk", schema: T, table: "accounts", columns: ["region", "code"],
      refSchema: T, refTable: "orgs", refColumns: ["region", "code"], onDelete: "SET NULL", onUpdate: "CASCADE",
    }]);
    const ix = (name: string) => s.indexes.find((i) => i.name === name);
    expect(ix("accounts_big")).toMatchObject({ columns: ["balance"], where: "balance > 1000::numeric", method: "btree", unique: false });
    expect(ix("accounts_tags")).toMatchObject({ method: "gin" });
    expect(ix("accounts_lower")!.columns).toEqual(["lower(email::text)"]);
    expect(ix("accounts_pkey")).toMatchObject({ primary: true, unique: true });
  });

  it("names the keys that point at a table, keeping key order", async () => {
    const res = await call<DbTableStructure>("GET", `/db/connections/${connId}/structure?schema=${T}&table=orgs`);
    expect(res.data.primaryKey!.columns).toEqual(["region", "code"]);
    expect(res.data.references.map((k) => [k.table, k.columns, k.refColumns])).toEqual([["accounts", ["region", "code"], ["region", "code"]]]);
  });

  it("describes a view and a materialized view, and 404s a table that does not exist", async () => {
    expect((await call<DbTableStructure>("GET", `/db/connections/${connId}/structure?schema=${T}&table=rich`)).data).toMatchObject({ kind: "view", rowKey: [] });
    expect((await call<DbTableStructure>("GET", `/db/connections/${connId}/structure?schema=${T}&table=totals`)).data.kind).toBe("matview");
    expect((await call("GET", `/db/connections/${connId}/structure?schema=${T}&table=nope`)).status).toBe(404);
  });
});
