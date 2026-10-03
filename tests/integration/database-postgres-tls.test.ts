/**
 * `sslmode` against a real Postgres. Until PPM read the mode itself, `verify-full` and
 * `verify-ca` connected in plain text to a server with TLS off — the one outcome those modes
 * exist to rule out. Runs when `PPM_TEST_PG_URL` names a server with `ssl = off`, e.g.
 *
 *   docker run --rm -d -p 25432:5432 -e POSTGRES_PASSWORD=x postgres:17
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:25432/postgres bun test tests/integration/database-postgres-tls.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { postgresService } from "../../src/services/postgres.service.ts";

const PG_URL = process.env.PPM_TEST_PG_URL;
let tlsOff = false;

beforeAll(async () => {
  if (!PG_URL) return;
  const sql = postgres(PG_URL, { max: 1 });
  try {
    tlsOff = (await sql`SHOW ssl`)[0]?.ssl === "off";
  } finally {
    await sql.end();
  }
});

afterAll(() => postgresService.closeAll());

const withMode = (mode: string) => `${PG_URL}${PG_URL!.includes("?") ? "&" : "?"}sslmode=${mode}`;

describe.skipIf(!PG_URL)("sslmode on a server with TLS off", () => {
  it("refuses verify-full, verify-ca and require rather than connecting in plain text", async () => {
    if (!tlsOff) return; // a server with TLS on proves nothing here
    for (const mode of ["verify-full", "verify-ca", "require"]) {
      const result = await postgresService.testConnection(withMode(mode));
      expect({ mode, ok: result.ok }).toEqual({ mode, ok: false });
    }
  });

  it("still connects when the URL allows plain text", async () => {
    if (!tlsOff) return;
    for (const mode of ["prefer", "allow", "disable"]) {
      const result = await postgresService.testConnection(withMode(mode));
      expect({ mode, ok: result.ok }).toEqual({ mode, ok: true });
    }
    expect((await postgresService.testConnection(PG_URL!)).ok).toBe(true);
  });
});
