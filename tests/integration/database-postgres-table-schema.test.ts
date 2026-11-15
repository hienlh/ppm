/**
 * `getTableSchema` against a real Postgres, for tables that share a name across schemas.
 * Runs only when `PPM_TEST_PG_URL` names a disposable database, e.g.
 *
 *   docker run --rm -d -p 25432:5432 -e POSTGRES_PASSWORD=x postgres:17-alpine
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:25432/postgres bun test tests/integration/database-postgres-table-schema.test.ts
 *
 * Everything it creates lives in schemas named after this run and is dropped at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { postgresService } from "../../src/services/postgres.service.ts";

const PG_URL = process.env.PPM_TEST_PG_URL;
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const A = `ppm_schema_a_${RUN}`;
const B = `ppm_schema_b_${RUN}`;

describe.skipIf(!PG_URL)("getTableSchema on Postgres", () => {
  const admin = PG_URL ? postgres(PG_URL, { max: 1, onnotice: () => {} }) : null;

  beforeAll(async () => {
    // Same table name and so the same primary key name (`items_pkey`) in both schemas.
    for (const s of [A, B]) {
      await admin!.unsafe(`CREATE SCHEMA ${s}`);
      await admin!.unsafe(`CREATE TABLE ${s}.owners (id int PRIMARY KEY)`);
      await admin!.unsafe(`CREATE TABLE ${s}.items (id serial PRIMARY KEY, owner_id int NOT NULL UNIQUE REFERENCES ${s}.owners(id), label text)`);
    }
    // A key that points into the other schema.
    await admin!.unsafe(`CREATE TABLE ${A}.links (id int PRIMARY KEY, owner_id int REFERENCES ${B}.owners(id))`);
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${A} CASCADE`);
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${B} CASCADE`);
    await admin.end();
  });

  it("lists each column once when another schema has a table and key of the same name", async () => {
    const cols = await postgresService.getTableSchema(PG_URL!, "items", A);
    expect(cols.map((c) => c.name)).toEqual(["id", "owner_id", "label"]);
    expect(cols.map((c) => c.pk)).toEqual([true, false, false]);
    expect(cols.find((c) => c.name === "owner_id")?.fk).toEqual({ table: "owners", column: "id" });
  });

  it("finds a foreign key whose target table is in another schema", async () => {
    const cols = await postgresService.getTableSchema(PG_URL!, "links", A);
    expect(cols.map((c) => c.name)).toEqual(["id", "owner_id"]);
    expect(cols.find((c) => c.name === "owner_id")?.fk).toEqual({ table: "owners", column: "id" });
  });
});
