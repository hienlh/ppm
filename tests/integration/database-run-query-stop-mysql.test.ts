/**
 * A read run with a time limit or a signal stops on the server: MySQL and MariaDB each `KILL
 * QUERY` it from a second session, report it as stopped rather than as a result, and leave
 * nothing running. Runs only when the URLs name disposable servers, e.g.
 *
 *   docker run --rm -d -p 127.0.0.1:23306:3306 -e MYSQL_ROOT_PASSWORD=x mysql:8.4
 *   docker run --rm -d -p 127.0.0.1:23307:3306 -e MARIADB_ROOT_PASSWORD=x mariadb:11
 *   PPM_TEST_MYSQL_URL=mysql://root:x@127.0.0.1:23306 PPM_TEST_MARIADB_URL=mariadb://root:x@127.0.0.1:23307 \
 *     bun test tests/integration/database-run-query-stop-mysql.test.ts
 *
 * The driver is installed the way Settings installs it, from the repository's own `mysql2`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import mysql2 from "mysql2/promise";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { installDbDriver } from "../../src/services/database/drivers/db-driver-install.ts";
import { readonlyMysqlService } from "../../src/services/mysql.service.ts";
import { QueryStoppedError } from "../../src/services/database/query-stop.ts";
import { copyingRunner } from "../helpers/db-driver-offline-install.ts";

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const ENGINES = [
  { name: "MySQL", url: process.env.PPM_TEST_MYSQL_URL },
  { name: "MariaDB", url: process.env.PPM_TEST_MARIADB_URL },
];

/** A read that runs for minutes: a cross join of three 2000-row derived tables. */
const slow = (tag: string) => {
  const side = "(SELECT 1 AS x FROM information_schema.COLUMNS a, information_schema.COLUMNS b LIMIT 2000)";
  return `SELECT count(*) AS n /* ${tag}-${RUN} */ FROM ${side} p, ${side} q, ${side} r`;
};

beforeAll(async () => {
  initAdapters();
  if (ENGINES.some((e) => e.url)) await installDbDriver("mysql", { run: copyingRunner("mysql") });
});

afterAll(async () => {
  await readonlyMysqlService.closeAll();
});

for (const engine of ENGINES) {
  describe.skipIf(!engine.url)(`stopping a read on ${engine.name}`, () => {
    let admin: mysql2.Connection;
    beforeAll(async () => {
      admin = await mysql2.createConnection({ uri: engine.url!.replace(/^mariadb:/, "mysql:") });
    });
    afterAll(async () => {
      await admin?.end();
    });

    const running = async (tag: string): Promise<number> => {
      const [rows] = await admin.query(
        "SELECT count(*) AS n FROM information_schema.PROCESSLIST WHERE INFO LIKE ? AND ID <> CONNECTION_ID() AND COMMAND = 'Query'",
        [`%${tag}-${RUN}%`],
      );
      return Number((rows as { n: number }[])[0]!.n);
    };

    it("stops at its time limit", async () => {
      const started = performance.now();
      const error = await readonlyMysqlService.runQuery(engine.url!, slow("timeout"), { timeoutMs: 500 }).catch((e) => e);
      expect(error).toBeInstanceOf(QueryStoppedError);
      expect((error as QueryStoppedError).reason).toBe("timeout");
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(await running("timeout")).toBe(0);
    });

    it("stops when its signal aborts, and the pool still serves the next read", async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 400);
      const started = performance.now();
      const error = await readonlyMysqlService.runQuery(engine.url!, slow("abort"), { signal: controller.signal }).catch((e) => e);
      expect(error).toBeInstanceOf(QueryStoppedError);
      expect((error as QueryStoppedError).reason).toBe("aborted");
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(await running("abort")).toBe(0);
      const next = await readonlyMysqlService.runQuery(engine.url!, "SELECT 1 AS one", { timeoutMs: 5_000 });
      expect(next.rows.map((row) => row.map(String))).toEqual([["1"]]);
    });
  });
}
