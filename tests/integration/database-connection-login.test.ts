/**
 * "Don't save, ask for password" against real servers, end to end: nothing about the password
 * reaches `ppm.db`, the connection opens only once Database Log In has a login that works, and
 * `ppm db` — a process of its own — asks at a terminal and refuses without one, which is what an
 * AI chat's shell is. Runs for each URL given, e.g.
 *
 *   PPM_TEST_PG_URL=postgres://postgres:x@127.0.0.1:25432/postgres \
 *   PPM_TEST_MYSQL_URL=mysql://root:x@127.0.0.1:23306 PPM_TEST_MARIADB_URL=mariadb://root:x@127.0.0.1:23307 \
 *     bun test tests/integration/database-connection-login.test.ts
 *
 * The CLI is spawned for real, against this run's own PPM directory; the terminal case goes
 * through util-linux `script`, which gives the child a pseudo-terminal.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { closeDb, decryptConfig, getConnectionById, getDbPath } from "../../src/services/db.service.ts";
import { _resetPpmDir } from "../../src/services/ppm-dir.ts";
import { _resetKeyPath, setKeyPath } from "../../src/lib/account-crypto.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { installDbDriver } from "../../src/services/database/drivers/db-driver-install.ts";
import { _clearHeldLogins } from "../../src/services/database/connection-login.ts";
import { closeAuditDb } from "../../src/services/query-audit/query-audit-db.ts";
import { postgresService, readonlyPostgresService } from "../../src/services/postgres.service.ts";
import { mysqlService, readonlyMysqlService } from "../../src/services/mysql.service.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import { buildDbUrl, parseDbUrl } from "../../src/shared/db-connection-url.ts";
import { DB_LOGIN_REQUIRED } from "../../src/shared/db-connection-config.ts";
import type { DbType } from "../../src/shared/db-types.ts";
import { copyingRunner } from "../helpers/db-driver-offline-install.ts";

const ENGINES: { type: Exclude<DbType, "sqlite">; url: string | undefined }[] = [
  { type: "postgres", url: process.env.PPM_TEST_PG_URL },
  { type: "mysql", url: process.env.PPM_TEST_MYSQL_URL },
  { type: "mariadb", url: process.env.PPM_TEST_MARIADB_URL },
];

const REPO = resolve(import.meta.dir, "../..");
const app = new Hono().route("/db", databaseRoutes);
const originalPpmHome = process.env.PPM_HOME;
const home = mkdtempSync(join(tmpdir(), "ppm-it-connection-login-"));
const hasScript = process.platform === "linux" && !!Bun.which("script");

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

function parts(url: string) {
  const parsed = parseDbUrl(url);
  if (parsed.kind !== "url") throw new Error(`unreadable test URL: ${url}`);
  return parsed.parts;
}

/** `ppm db …` as its own process, on this run's PPM directory, with no terminal. */
async function cliWithoutTerminal(...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", join(REPO, "src/index.ts"), "db", ...args], {
    cwd: REPO, env: { ...process.env, PPM_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, errText, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out + errText };
}

/**
 * `ppm db …` on a pseudo-terminal: each answer is typed once its prompt has appeared, the way a
 * person would, and nothing is typed early into a terminal that still echoes.
 */
async function cliOnTerminal(answers: { prompt: string; text: string }[], ...args: string[]): Promise<{ code: number; out: string }> {
  const command = ["bun", join(REPO, "src/index.ts"), "db", ...args].map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ");
  const proc = Bun.spawn(["script", "-qec", command, "/dev/null"], {
    cwd: REPO, env: { ...process.env, PPM_HOME: home }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let out = "";
  const pending = [...answers];
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  const deadline = setTimeout(() => proc.kill(), 30_000);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
    while (pending.length && out.includes(pending[0]!.prompt)) {
      proc.stdin.write(`${pending.shift()!.text}\r`);
      proc.stdin.flush();
    }
  }
  clearTimeout(deadline);
  proc.stdin.end();
  return { code: await proc.exited, out };
}

beforeAll(async () => {
  process.env.PPM_HOME = home;
  _resetPpmDir();
  // The key the CLI will read, not one an earlier test file pointed this process at.
  setKeyPath(join(home, "account.key"));
  // A real file under PPM_HOME, so what is on disk can be read back byte for byte.
  closeDb();
  initAdapters();
  if (ENGINES.some((e) => e.url && e.type !== "postgres")) await installDbDriver("mysql", { run: copyingRunner("mysql") });
});

afterAll(async () => {
  _clearHeldLogins();
  await Promise.all([postgresService, readonlyPostgresService, mysqlService, readonlyMysqlService].map((s) => s.closeAll()));
  closeDb();
  // The query log is a file in `home` too, and Windows deletes no file that is open.
  closeAuditDb();
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  _resetKeyPath();
  rmSync(home, { recursive: true, force: true });
});

for (const engine of ENGINES) {
  describe.skipIf(!engine.url)(`${engine.type}: ask for password`, () => {
    const url = engine.url!;
    // A skipped describe's body still runs, to collect its tests: with no URL there is nothing to parse.
    const secret = engine.url ? parts(url).password : "";
    const name = `ask-${engine.type}`;
    let id = 0;

    beforeAll(async () => {
      const created = await call("POST", "/db/connections", {
        type: engine.type, name, connectionConfig: { type: engine.type, connectionString: url, passwordMode: "askPassword" },
      });
      expect(created.status).toBe(201);
      id = created.json.data.id;
    });

    it("writes no password to ppm.db", () => {
      expect(decryptConfig(getConnectionById(id)!.connection_config)).toEqual({
        type: engine.type, connectionString: buildDbUrl({ ...parts(url), password: "" }), passwordMode: "askPassword",
      });
      for (const file of [getDbPath(), `${getDbPath()}-wal`]) {
        if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(secret))).toBe(false);
      }
    });

    it("opens only with a login that works, and closes again on Disconnect", async () => {
      expect(await call("GET", `/db/connections/${id}/tables`)).toMatchObject({ status: 428, json: { code: DB_LOGIN_REQUIRED } });

      const wrong = await call("POST", `/db/connections/${id}/login`, { password: "not-the-password" });
      expect(wrong.json.data).toMatchObject({ ok: false });
      expect((await call("GET", `/db/connections/${id}/tables`)).status).toBe(428);

      const right = await call("POST", `/db/connections/${id}/login`, { password: secret });
      expect(right.json.data).toMatchObject({ ok: true });
      expect((await call("GET", `/db/connections/${id}/tables`)).status).toBe(200);
      const query = await call("POST", `/db/connections/${id}/query`, { sql: "SELECT 1 AS one" });
      expect(query.status).toBe(200);

      await call("POST", `/db/connections/${id}/disconnect`);
      expect((await call("GET", `/db/connections/${id}/tables`)).status).toBe(428);
    });

    it("`ppm db query` without a terminal refuses, saying why", async () => {
      const { code, out } = await cliWithoutTerminal("query", name, "SELECT 1");
      expect(code).toBe(1);
      expect(out).toContain(`Connection "${name}" asks for its password each time it is opened, and this command has no terminal to ask on`);
      expect(out).toContain("An AI chat cannot use this connection.");
    });

    it.skipIf(!hasScript)("`ppm db query` at a terminal asks for the password, without echoing it", async () => {
      const { code, out } = await cliOnTerminal([{ prompt: "Password for", text: secret }], "query", name, "SELECT 1 AS one");
      expect({ code, out }).toMatchObject({ code: 0 });
      expect(out).toContain(`Password for ${parts(url).user} on ${name}: `);
      expect(out).toContain("one");
      expect(out).not.toContain(secret);
    });
  });
}
