/**
 * The connection form's Test against real servers: the version and databases on success, the
 * driver's own error with its code on a wrong password, and a saved password standing in for a
 * field left empty. Runs for each URL given, e.g.
 *
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:25432/postgres \
 *   PPM_TEST_MYSQL_URL=mysql://root:x@127.0.0.1:23306 PPM_TEST_MARIADB_URL=mariadb://root:x@127.0.0.1:23307 \
 *     bun test tests/integration/database-connection-test.test.ts
 *
 * The MySQL driver is installed into this run's own PPM directory, as Settings would.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../src/services/db.service.ts";
import { _resetPpmDir } from "../../src/services/ppm-dir.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { installDbDriver } from "../../src/services/database/drivers/db-driver-install.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import { buildDbUrl, parseDbUrl } from "../../src/shared/db-connection-url.ts";
import type { DbType } from "../../src/shared/db-types.ts";
import { copyingRunner } from "../helpers/db-driver-offline-install.ts";

/** `has`: a database the server is expected to list — the MySQL containers PPM tests against carry a `shop`. */
const ENGINES: { type: Exclude<DbType, "sqlite">; url: string | undefined; version: RegExp; has: string; hidden: string[] }[] = [
  { type: "postgres", url: process.env.PPM_TEST_PG_URL, version: /^PostgreSQL \d+\.\d+/, has: "postgres", hidden: ["template0", "template1"] },
  { type: "mysql", url: process.env.PPM_TEST_MYSQL_URL, version: /^MySQL \d+\.\d+\.\d+$/, has: "shop", hidden: ["mysql", "sys", "information_schema", "performance_schema"] },
  { type: "mariadb", url: process.env.PPM_TEST_MARIADB_URL, version: /^MariaDB \d+\.\d+\.\d+$/, has: "shop", hidden: ["mysql", "sys", "information_schema", "performance_schema"] },
];

const app = new Hono().route("/db", databaseRoutes);
const originalPpmHome = process.env.PPM_HOME;
const home = mkdtempSync(join(tmpdir(), "ppm-it-connection-test-"));

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

/** The same URL with another password, or none. */
function withPassword(url: string, password: string): string {
  const parsed = parseDbUrl(url);
  if (parsed.kind !== "url") throw new Error(`unreadable test URL: ${url}`);
  return buildDbUrl({ ...parsed.parts, password });
}

beforeAll(async () => {
  process.env.PPM_HOME = home;
  _resetPpmDir();
  setDb(openTestDb());
  initAdapters();
  if (ENGINES.some((e) => e.url && e.type !== "postgres")) await installDbDriver("mysql", { run: copyingRunner("mysql") });
});

afterAll(() => {
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  rmSync(home, { recursive: true, force: true });
});

for (const engine of ENGINES) {
  describe.skipIf(!engine.url)(`${engine.type}: POST /db/test`, () => {
    const url = engine.url!;
    const test = (connectionString: string, extra: Record<string, unknown> = {}) =>
      call("POST", "/db/test", { type: engine.type, connectionConfig: { type: engine.type, connectionString }, ...extra });

    it("answers with the server's version and the databases the login can open", async () => {
      const { status, json } = await test(url);
      expect(status).toBe(200);
      const result = json.data;
      expect(result).toMatchObject({ ok: true, version: expect.stringMatching(engine.version), elapsedMs: expect.any(Number) });
      expect(result.databases).toContain(engine.has);
      for (const name of engine.hidden) expect(result.databases).not.toContain(name);
      // With no TLS parameter the connection is plain text, and the result says so; the cases with
      // one are in database-ssh-ssl.test.ts.
      const parsed = parseDbUrl(url);
      if (parsed.kind === "url" && !parsed.parts.ssl) expect(result.tls).toBeNull();
    });

    it("answers a wrong password with the driver's own error and its code, and saves nothing", async () => {
      const before = (await call("GET", "/db/connections")).json.data.length;
      const { json } = await test(withPassword(url, "definitely-wrong"));
      const result = json.data;
      expect(result.ok).toBe(false);
      if (engine.type === "postgres") {
        expect(result.error).toContain("password authentication failed");
        expect(result.details).toContain("SQLSTATE 28P01 (invalid_password)");
      } else {
        expect(result.error).toContain("Access denied");
        expect(result.details).toContain("ER_ACCESS_DENIED_ERROR · errno 1045 · SQLSTATE 28000");
      }
      expect(result.details).toContain("Checked from the PPM host");
      expect(JSON.stringify(json)).not.toContain("definitely-wrong");
      expect((await call("GET", "/db/connections")).json.data.length).toBe(before);
    });

    it("uses the saved password for a field left empty when editing", async () => {
      const created = await call("POST", "/db/connections", {
        type: engine.type, name: `saved-${engine.type}`, connectionConfig: { type: engine.type, connectionString: url },
      });
      expect(created.status).toBe(201);
      const id = created.json.data.id;
      const edit = (await call("GET", `/db/connections/${id}/config`)).json.data;
      expect(edit.hasPassword).toBe(true);

      const withSaved = await test(edit.connectionString, { connectionId: id, connectionConfig: { type: engine.type, connectionString: edit.connectionString, keepPassword: true } });
      expect(withSaved.json.data.ok).toBe(true);
      // Without keepPassword the empty field means no password, and the server says so.
      const without = await test(edit.connectionString, { connectionId: id });
      expect(without.json.data.ok).toBe(false);
    });

    it("tests a connection that asks for its password with the login it was given", async () => {
      const parsed = parseDbUrl(url);
      if (parsed.kind !== "url") throw new Error("unreadable test URL");
      const config = { type: engine.type, connectionString: withPassword(url, ""), passwordMode: "askPassword" };
      const right = await call("POST", "/db/test", { type: engine.type, connectionConfig: config, login: { password: parsed.parts.password } });
      expect(right.json.data.ok).toBe(true);
      const wrong = await call("POST", "/db/test", { type: engine.type, connectionConfig: config, login: { password: "nope-nope" } });
      expect(wrong.json.data.ok).toBe(false);
    });
  });
}
