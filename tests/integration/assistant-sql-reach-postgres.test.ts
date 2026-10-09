/**
 * The Assistant's catalog check against a real Postgres: a query whose text passes is refused
 * when it reaches a function off the safe list through a view, a policy or a user operator, or
 * calls a name a user function shadows — and the check itself runs none of them, which EXPLAIN
 * does. Runs only when `PPM_TEST_PG_URL` names a disposable database, e.g.
 *
 *   docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=x postgres:15
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55432/postgres bun test tests/integration/assistant-sql-reach-postgres.test.ts
 *
 * Everything it creates lives in one schema named after this run and is dropped at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { insertConnection, openTestDb, setDb } from "../../src/services/db.service.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { readonlyPostgresService } from "../../src/services/postgres.service.ts";
import { assistantSqlSafety } from "../../src/services/assistant-mcp/assistant-sql-safety.ts";
import { assistantSqlReachSafety, type CatalogReader } from "../../src/services/assistant-mcp/assistant-sql-reach-check.ts";
import { dbQuery } from "../../src/services/assistant-mcp/assistant-db-tools.ts";
import type { AskApproval } from "../../src/services/assistant-mcp/assistant-approval-broker.ts";

const PG_URL = process.env.PPM_TEST_PG_URL;
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const S = `ppm_reach_${RUN}`;
/** Advisory lock keys the fixtures' functions take: held afterwards only if one of them ran. */
const KEY = Math.floor(Math.random() * 1e9);
const KEYS = [KEY, KEY + 1, KEY + 2, KEY + 3, KEY + 4, KEY + 5];
/** A function on the search path, reached by writing it as a column of a row of `t`. */
const ROW_FN = `leak_${RUN}`;
const CALLER = { actor: "agent" as const, callerIp: null, callerUa: "PPM Assistant (integration test)" };

const read: CatalogReader = async (sql) => (await readonlyPostgresService.runQuery(PG_URL!, sql)).rows;

async function check(sql: string) {
  const called = new Set<string>();
  const text = assistantSqlSafety(sql, "postgres", called);
  expect(text).toEqual({ proven: true });
  return assistantSqlReachSafety(sql, "postgres", called, read);
}

describe.skipIf(!PG_URL)("assistant catalog check on Postgres", () => {
  const admin = PG_URL ? postgres(PG_URL, { max: 1, onnotice: () => {} }) : null;
  const heldLocks = async (): Promise<number> => {
    const [row] = await admin!.unsafe(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid IN (${KEYS.join(", ")})`);
    return (row as { n: number }).n;
  };

  beforeAll(async () => {
    initAdapters();
    setDb(openTestDb());
    await admin!.unsafe(`
      CREATE SCHEMA ${S};
      CREATE TABLE ${S}.t (id int, name varchar(20));
      INSERT INTO ${S}.t VALUES (1, 'Ann'), (2, 'Bo');
      CREATE FUNCTION ${S}.lower(varchar) RETURNS text LANGUAGE plpgsql IMMUTABLE
        AS $$ BEGIN PERFORM pg_advisory_lock(${KEYS[0]}); RETURN 'x'; END $$;
      CREATE FUNCTION ${S}.evil(int) RETURNS int LANGUAGE plpgsql STABLE
        AS $$ BEGIN PERFORM pg_advisory_lock(${KEYS[1]}); RETURN 1; END $$;
      CREATE VIEW ${S}.v_evil AS SELECT id FROM ${S}.t WHERE id = ${S}.evil(1);
      CREATE VIEW ${S}.v_nested AS SELECT * FROM ${S}.v_evil;
      CREATE VIEW ${S}.v_values AS VALUES (pg_try_advisory_lock(${KEYS[2]}));
      CREATE VIEW ${S}.v_plain AS SELECT id, lower(name::text) AS l, count(*) OVER () AS n FROM ${S}.t;
      CREATE TABLE ${S}.secret (id int);
      ALTER TABLE ${S}.secret ENABLE ROW LEVEL SECURITY;
      CREATE POLICY p ON ${S}.secret FOR SELECT USING (pg_try_advisory_lock(${KEYS[3]}));
      CREATE FUNCTION ${S}.cat(text, text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT $1 || $2';
      CREATE OPERATOR ${S}.@@@ (leftarg = text, rightarg = text, function = ${S}.cat);
      CREATE FUNCTION public.${ROW_FN}(${S}.t) RETURNS int LANGUAGE plpgsql STABLE
        AS $$ BEGIN PERFORM pg_advisory_lock(${KEYS[4]}); RETURN 1; END $$;
      CREATE OR REPLACE FUNCTION public.first(bigint) RETURNS int LANGUAGE plpgsql STABLE
        AS $$ BEGIN PERFORM pg_advisory_lock(${KEYS[5]}); RETURN 1; END $$;
    `).simple();
  });

  afterAll(async () => {
    await admin?.unsafe(`DROP SCHEMA IF EXISTS ${S} CASCADE; DROP FUNCTION IF EXISTS public.first(bigint)`).simple().catch(() => {});
    await readonlyPostgresService.close(PG_URL!).catch(() => {});
    await admin?.end({ timeout: 5 });
  });

  it("proves a view that calls only pg_catalog functions, and a plain read", async () => {
    expect(await check(`SELECT * FROM ${S}.v_plain`)).toEqual({ proven: true });
    expect(await check(`SELECT count(*), upper(name) FROM ${S}.t`)).toEqual({ proven: true });
  });

  it("refuses what a view, a nested view or a policy reaches", async () => {
    expect(await check(`SELECT * FROM ${S}.v_nested`)).toMatchObject({ proven: false, reason: expect.stringContaining(`${S}.evil()`) });
    expect(await check(`SELECT * FROM ${S}.v_values`)).toMatchObject({ proven: false, reason: expect.stringContaining("pg_try_advisory_lock()") });
    expect(await check(`SELECT * FROM ${S}.secret`)).toMatchObject({ proven: false, reason: expect.stringContaining("row-level security policy p") });
  });

  it("refuses a name a user function shadows, and a user operator", async () => {
    expect(await check(`SELECT lower(name) FROM ${S}.t`)).toMatchObject({ proven: false, reason: expect.stringContaining("named lower") });
    expect(await check(`SELECT name::text @@@ 'x' FROM ${S}.t`)).toMatchObject({ proven: false, reason: expect.stringContaining("@@@") });
  });

  it("refuses a user function written as a column of a row, which has no parenthesis to see", async () => {
    // Postgres reads `r.leak_…` as `leak_…(r)` because `t` has no column of that name.
    expect(await check(`SELECT r.${ROW_FN} FROM ${S}.t r`)).toMatchObject({ proven: false, reason: expect.stringContaining(`written as t.${ROW_FN}`) });
    expect(await check(`SELECT (r).${ROW_FN} FROM ${S}.t r`)).toMatchObject({ proven: false });
  });

  it("ran none of those functions while checking", async () => {
    expect(await heldLocks()).toBe(0);
  });

  it("asks before a call named by a keyword Postgres does not reserve, and before a column-style call", async () => {
    const conn = insertConnection("postgres", `kw-${RUN}`, { type: "postgres", connectionString: PG_URL! });
    const asked: string[] = [];
    const decline: AskApproval = async (a) => { asked.push(String(a.input.sql)); return { verdict: "denied", reason: "The user declined." }; };
    for (const sql of ["SELECT first(1)", `SELECT r.${ROW_FN} FROM ${S}.t r`]) {
      const result = await dbQuery({ connectionId: conn.id, sql }, CALLER, decline);
      expect(result.isError).toBe(true);
    }
    expect(asked).toHaveLength(2);
    expect(await heldLocks()).toBe(0);
  });

  it("stops an unasked read at its time limit, and when its call is cancelled, on the server", async () => {
    const conn = insertConnection("postgres", `stop-${RUN}`, { type: "postgres", connectionString: PG_URL! });
    const slow = (tag: string) => `SELECT count(*) /* ${tag}-${RUN} */ FROM generate_series(1, 3000000000)`;
    const running = async (tag: string): Promise<number> => {
      const [row] = await admin!.unsafe(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%${tag}-${RUN}%' AND pid <> pg_backend_pid()`);
      return (row as { n: number }).n;
    };

    let started = performance.now();
    const timedOut = await dbQuery({ connectionId: conn.id, sql: slow("timeout") }, CALLER, undefined, undefined, { timeoutMs: 400 });
    expect(timedOut.isError).toBe(true);
    expect(JSON.stringify(timedOut)).toContain("longer than 400 ms");
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(await running("timeout")).toBe(0);

    const controller = new AbortController();
    started = performance.now();
    setTimeout(() => controller.abort(), 400);
    const aborted = await dbQuery({ connectionId: conn.id, sql: slow("abort") }, CALLER, undefined, undefined, { signal: controller.signal });
    expect(aborted.isError).toBe(true);
    expect(JSON.stringify(aborted)).toContain("was stopped");
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(await running("abort")).toBe(0);
  });

  it("is checked by db_query before anything runs, and a refused read is not run without approval", async () => {
    const conn = insertConnection("postgres", `reach-${RUN}`, { type: "postgres", connectionString: PG_URL! });
    const asked: string[] = [];
    const decline: AskApproval = async (a) => { asked.push(String(a.input.sql)); return { verdict: "denied", reason: "The user declined." }; };
    const refused = await dbQuery({ connectionId: conn.id, sql: `SELECT * FROM ${S}.v_values` }, CALLER, decline);
    expect(refused.isError).toBe(true);
    expect(asked).toEqual([`SELECT * FROM ${S}.v_values`]);
    expect(await heldLocks()).toBe(0);
    const ran = await dbQuery({ connectionId: conn.id, sql: `SELECT id, l FROM ${S}.v_plain ORDER BY id` }, CALLER, decline);
    expect(ran.isError).toBeUndefined();
    expect(asked).toHaveLength(1);
  });

  // Why the check reads the catalog instead of planning: EXPLAIN alone runs a STABLE function a
  // view filters on (selectivity estimation folds it), with no ANALYZE and nothing executed.
  it("EXPLAIN, by contrast, runs a function the view reaches", async () => {
    const probe = postgres(PG_URL!, { max: 1, onnotice: () => {} });
    try {
      await probe.unsafe(`EXPLAIN SELECT * FROM ${S}.v_evil`);
      expect(await heldLocks()).toBe(1);
    } finally {
      await probe.end({ timeout: 5 });
    }
  });
});
