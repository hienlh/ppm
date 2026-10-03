/**
 * A readonly Postgres connection is refused by Postgres itself, not only by
 * reading the SQL: `SELECT nextval('s')` and a function that deletes read
 * like reads. Runs only when `PPM_TEST_PG_URL` names a disposable database, e.g.
 *
 *   docker run --rm -d -p 25432:5432 -e POSTGRES_PASSWORD=x postgres:17
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:25432/postgres bun test tests/integration/database-readonly-postgres.test.ts
 *
 * Everything it creates lives in one schema named after this run and is dropped at the end.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { Command } from "commander";
import postgres from "postgres";
import { insertConnection, openTestDb, setDb, updateConnection } from "../../src/services/db.service.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { postgresService, readonlyPostgresService } from "../../src/services/postgres.service.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import { registerDbCommands } from "../../src/cli/commands/db-cmd.ts";
import { getAuditDb } from "../../src/services/query-audit/query-audit-db.ts";
import { listQueryLogs } from "../../src/services/query-audit/query-audit.service.ts";
import type { QueryRunResponse } from "../../src/shared/db-grid.ts";

const PG_URL = process.env.PPM_TEST_PG_URL;
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const S = `ppm_ro_${RUN}`;

const app = () => new Hono().route("/db", databaseRoutes);

async function post<T>(path: string, body: unknown): Promise<{ status: number; data: T; error?: string }> {
  const res = await app().request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { data: T; error?: string };
  return { status: res.status, data: json.data, error: json.error };
}

describe.skipIf(!PG_URL)("readonly Postgres connection", () => {
  const admin = PG_URL ? postgres(PG_URL, { max: 1, onnotice: () => {} }) : null;
  let ro = 0;
  let rw = 0;
  const query = (id: number, sql: string) => post<QueryRunResponse>(`/db/connections/${id}/query`, { sql });
  const lastValue = async () => (await admin!.unsafe(`SELECT is_called FROM ${S}.seq`))[0]!.is_called as boolean;
  const peopleCount = async () => (await admin!.unsafe(`SELECT count(*)::int AS n FROM ${S}.people`))[0]!.n as number;

  beforeAll(async () => {
    initAdapters();
    await admin!.unsafe(`
      CREATE SCHEMA ${S};
      CREATE SEQUENCE ${S}.seq;
      CREATE TABLE ${S}.people (id int PRIMARY KEY, name text);
      INSERT INTO ${S}.people VALUES (1, 'a'), (2, 'b');
      CREATE FUNCTION ${S}.wipe() RETURNS int LANGUAGE sql AS $$ DELETE FROM ${S}.people RETURNING 1 $$;
    `);
  });

  beforeEach(() => {
    setDb(openTestDb());
    getAuditDb().exec("DELETE FROM query_log");
    ro = insertConnection("postgres", "ro", { type: "postgres", connectionString: PG_URL! }).id;
    rw = insertConnection("postgres", "rw", { type: "postgres", connectionString: PG_URL! }).id;
    updateConnection(rw, { readonly: 0 });
  });

  afterAll(async () => {
    await admin?.unsafe(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await admin?.end();
    await postgresService.closeAll();
    await readonlyPostgresService.closeAll();
  });

  it("refuses SELECT nextval(), which the SQL check lets through, and audits it as blocked", async () => {
    const res = await query(ro, `SELECT nextval('${S}.seq')`);
    expect(res.status).toBe(403);
    expect(res.error).toContain("cannot execute nextval() in a read-only transaction");
    expect(await lastValue()).toBe(false);
    expect(listQueryLogs({ connectionId: ro })[0]).toMatchObject({ status: "blocked", source: "editor" });
  });

  it("refuses a function that deletes", async () => {
    const res = await query(ro, `SELECT ${S}.wipe()`);
    expect(res.status).toBe(403);
    expect(res.error).toContain("cannot execute DELETE in a read-only transaction");
    expect(await peopleCount()).toBe(2);
    expect(listQueryLogs({ connectionId: ro })[0]!.status).toBe("blocked");
  });

  it("cannot be switched back to read-write from inside a query", async () => {
    const res = await query(ro, `SELECT set_config('default_transaction_read_only', 'off', false); SELECT nextval('${S}.seq')`);
    expect(res.status).toBe(403);
    expect(await lastValue()).toBe(false);
    // The set_config went back with the rolled-back transaction.
    const after = await query(ro, "SHOW default_transaction_read_only");
    expect(after.data.rows).toEqual([["on"]]);
  });

  it("answers reads, several statements included", async () => {
    const res = await query(ro, `SELECT 1 AS a; SELECT name FROM ${S}.people ORDER BY id`);
    expect(res.status).toBe(200);
    expect(res.data.rows).toEqual([["a"], ["b"]]);
  });

  it("refuses a grid condition written in SQL that writes", async () => {
    const res = await post(`/db/connections/${ro}/grid`, {
      table: "people", schema: S,
      filters: [{ column: "id", anyOf: [[{ op: "rawSql", sql: `$$ > 0 AND nextval('${S}.seq') > 0` }]] }],
    });
    expect(res.status).toBe(403);
    expect(res.error).toContain("read-only transaction");
    expect(await lastValue()).toBe(false);
    expect(listQueryLogs({ connectionId: ro })[0]).toMatchObject({ status: "blocked", source: "filter" });
  });

  it("runs the same statement on a writable connection, so the refusal is readonly's", async () => {
    const res = await query(rw, `SELECT nextval('${S}.seq')`);
    expect(res.status).toBe(200);
    expect(await lastValue()).toBe(true);
    await admin!.unsafe(`ALTER SEQUENCE ${S}.seq RESTART`);
  });

  describe("ppm db query", () => {
    let errors: string[];
    let out: string[];
    let exit: ReturnType<typeof spyOn>;

    beforeEach(() => {
      errors = [];
      out = [];
      exit = spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
      spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(args.join(" ")); });
      spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.join(" ")); });
    });

    afterEach(() => {
      exit.mockRestore();
      (console.log as unknown as { mockRestore(): void }).mockRestore();
      (console.error as unknown as { mockRestore(): void }).mockRestore();
    });

    const run = (...args: string[]) => {
      const program = new Command();
      registerDbCommands(program);
      return program.parseAsync(["db", ...args], { from: "user" });
    };

    it("is refused by Postgres on a readonly connection", async () => {
      await expect(run("query", String(ro), `SELECT nextval('${S}.seq')`)).rejects.toThrow("exit 1");
      expect(errors.join("\n")).toContain("read-only transaction");
      expect(await lastValue()).toBe(false);
      expect(listQueryLogs({ connectionId: ro })[0]).toMatchObject({ source: "cli", status: "blocked" });
    });

    it("still runs on a writable connection as before", async () => {
      await run("query", String(rw), `SELECT name FROM ${S}.people ORDER BY id`, "--json");
      expect(JSON.parse(out.at(-1)!).rows).toEqual([{ name: "a" }, { name: "b" }]);
    });
  });
});
