/**
 * The SSH Tunnel and SSL tabs against real servers: OpenSSH in front of a Postgres and a MariaDB
 * that PPM can only reach through it, each serving a certificate signed by a CA of the test's own
 * (`fixtures/ssh-ssl-lab.ts`). Opt-in, since it builds an image and starts five containers:
 *
 *   PPM_TEST_DOCKER=1 bun test tests/integration/database-ssh-ssl.test.ts
 *
 * The drivers are installed into this run's own PPM directory, as Settings would, and the CLI is
 * spawned for real against it. The cases run in order: host keys recorded by one are what the
 * next one sees.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Hono } from "hono";
import { closeDb, getConnectionById } from "../../src/services/db.service.ts";
import { _resetPpmDir } from "../../src/services/ppm-dir.ts";
import { _resetKeyPath, setKeyPath } from "../../src/lib/account-crypto.ts";
import { initAdapters } from "../../src/services/database/init-adapters.ts";
import { installDbDriver } from "../../src/services/database/drivers/db-driver-install.ts";
import { closeAllSshTunnels, openSshTunnelCount } from "../../src/services/database/ssh-tunnel.ts";
import { knownHostsPath } from "../../src/services/database/ssh-known-hosts.ts";
import { postgresService, readonlyPostgresService } from "../../src/services/postgres.service.ts";
import { mysqlService, readonlyMysqlService } from "../../src/services/mysql.service.ts";
import { databaseRoutes } from "../../src/server/routes/database.ts";
import type { DbType } from "../../src/shared/db-types.ts";
import { copyingRunner } from "../helpers/db-driver-offline-install.ts";
import { dockerAvailable, KEY_PASSPHRASE, MARIADB_PASSWORD, PG_PASSWORD, startLab, type Lab } from "./fixtures/ssh-ssl-lab.ts";

const enabled = process.env.PPM_TEST_DOCKER === "1" && process.platform !== "win32";
const REPO = resolve(import.meta.dir, "../..");
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const UNTRUSTED = /self[- ]signed certificate in certificate chain/;

const app = new Hono().route("/db", databaseRoutes);
const originalPpmHome = process.env.PPM_HOME;
const home = mkdtempSync(join(tmpdir(), "ppm-it-ssh-ssl-"));

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

async function until(what: string, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what} within ${timeoutMs} ms`);
    await Bun.sleep(100);
  }
}

describe.skipIf(!enabled)("SSH tunnel and SSL files, through OpenSSH to Postgres and MariaDB", () => {
  let lab: Lab;

  /** alice's password login on `sshd`, as the form sends it. */
  const alice = (extra: Record<string, unknown> = {}) =>
    ({ enabled: true, host: "127.0.0.1", port: String(lab.sshPort), auth: "password", user: "alice", password: "secret", ...extra });
  const pgUrl = (host = "pg", query = "?sslmode=verify-full") => `postgres://app:${PG_PASSWORD}@${host}:5432/shop${query}`;
  const mariadbUrl = (host: string) => `mariadb://root:${MARIADB_PASSWORD}@${host}:3306/shop?ssl-mode=VERIFY_IDENTITY`;
  const withCa = () => ({ ca: lab.ca });

  /** The form's Test: `POST /db/test`, answered with the result. */
  async function test(type: Exclude<DbType, "sqlite">, connectionString: string, ssh?: unknown, ssl?: unknown, extra: Record<string, unknown> = {}) {
    const res = await call("POST", "/db/test", { type, connectionConfig: { type, connectionString, ...(ssh ? { ssh } : {}), ...(ssl ? { ssl } : {}) }, ...extra });
    expect({ status: res.status, body: res.json }).toMatchObject({ status: 200 });
    return res.json.data;
  }

  async function save(name: string, type: Exclude<DbType, "sqlite">, connectionConfig: Record<string, unknown>): Promise<number> {
    const res = await call("POST", "/db/connections", { type, name, connectionConfig: { type, ...connectionConfig } });
    expect({ status: res.status, body: res.json }).toMatchObject({ status: 201 });
    return res.json.data.id;
  }

  /** Database sessions that came in through the tunnel: from `sshd`'s address on the databases' network. */
  async function tunnelledSessions(): Promise<number> {
    const [row] = await lab.pgAdmin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE client_addr = ${lab.sshdIp}::inet`;
    return row!.n as number;
  }

  beforeAll(async () => {
    if (!(await dockerAvailable())) throw new Error("PPM_TEST_DOCKER=1 is set, but docker does not answer");
    process.env.PPM_HOME = home;
    _resetPpmDir();
    // The key the CLI will read, and a real ppm.db under PPM_HOME that it can open too.
    setKeyPath(join(home, "account.key"));
    closeDb();
    initAdapters();
    await installDbDriver("ssh", { run: copyingRunner("ssh") });
    await installDbDriver("mysql", { run: copyingRunner("mysql") });
    lab = await startLab();
  }, 300_000);

  afterAll(async () => {
    await Promise.all([postgresService, readonlyPostgresService, mysqlService, readonlyMysqlService].map((s) => s.closeAll()));
    closeAllSshTunnels();
    await lab?.close();
    closeDb();
    if (originalPpmHome === undefined) delete process.env.PPM_HOME;
    else process.env.PPM_HOME = originalPpmHome;
    _resetPpmDir();
    _resetKeyPath();
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  it("reaches Postgres through the tunnel, checking its certificate against the CA, and records the host key", async () => {
    const first = await test("postgres", pgUrl(), alice(), withCa());
    expect(first).toMatchObject({ ok: true, target: "pg:5432", tls: "TLSv1.3", version: expect.stringMatching(/^PostgreSQL 17\./) });
    expect(first.databases).toContain("shop");
    expect(first.ssh).toEqual([{ host: `127.0.0.1:${lab.sshPort}`, fingerprint: expect.stringMatching(FINGERPRINT), firstSeen: true }]);
    // The Test logged in on a session of its own, and closed it.
    expect(openSshTunnelCount()).toBe(0);

    const second = await test("postgres", pgUrl(), alice(), withCa());
    expect(second.ssh).toEqual([{ ...first.ssh[0], firstSeen: false }]);
  }, 30_000);

  it("refuses the certificate without the CA, and one that names another server", async () => {
    const noCa = await test("postgres", pgUrl(), alice());
    expect(noCa.ok).toBe(false);
    expect(noCa.error).toMatch(UNTRUSTED);
    const other = await test("postgres", pgUrl("pg-other"), alice(), withCa());
    expect(other.ok).toBe(false);
    expect(other.error).toContain("Host: pg-other. is not in the cert's altnames");
  }, 30_000);

  it("checks the certificate's name for a server named by IP address, directly and through the tunnel", async () => {
    // Bun checks the name only when a driver names the server, which neither does for an address
    // (tls-identity-check.ts): every refusal below was a connection before.
    const pgDirect = (mode: string) => `postgres://app:${PG_PASSWORD}@127.0.0.1:${lab.pgPort}/shop?sslmode=${mode}`;
    const direct = await test("postgres", pgDirect("verify-full"), undefined, withCa());
    expect(direct.ok).toBe(false);
    expect(direct.error).toContain("IP: 127.0.0.1 is not in the cert's list");
    // verify-ca asks nothing of the name.
    expect(await test("postgres", pgDirect("verify-ca"), undefined, withCa())).toMatchObject({ ok: true, tls: "TLSv1.3" });
    expect(await test("postgres", pgUrl(lab.pgIp), alice(), withCa())).toMatchObject({ ok: true, target: `${lab.pgIp}:5432`, tls: "TLSv1.3" });
    const pgOther = await test("postgres", pgUrl(lab.pgOtherIp), alice(), withCa());
    expect(pgOther.ok).toBe(false);
    expect(pgOther.error).toContain(`IP: ${lab.pgOtherIp} is not in the cert's list`);

    const mariadbDirect = (mode: string) => `mariadb://root:${MARIADB_PASSWORD}@127.0.0.1:${lab.mariadbPort}/shop?ssl-mode=${mode}`;
    const mDirect = await test("mariadb", mariadbDirect("VERIFY_IDENTITY"), undefined, withCa());
    expect(mDirect.ok).toBe(false);
    expect(mDirect.error).toContain("IP: 127.0.0.1 is not in the cert's list");
    expect(await test("mariadb", mariadbDirect("VERIFY_CA"), undefined, withCa())).toMatchObject({ ok: true, tls: "TLSv1.3" });
    const mOther = await test("mariadb", mariadbUrl(lab.mariadbOtherIp), alice(), withCa());
    expect(mOther.ok).toBe(false);
    expect(mOther.error).toContain(`IP: ${lab.mariadbOtherIp} is not in the cert's list`);
  }, 60_000);

  it("goes through a bastion to an SSH server only the bastion can reach", async () => {
    const direct = await test("postgres", pgUrl(), alice(), withCa());
    const result = await test("postgres", pgUrl(), alice({ host: "sshd", port: "22", bastionHost: `alice@127.0.0.1:${lab.bastionPort}` }), withCa());
    expect(result).toMatchObject({ ok: true, tls: "TLSv1.3" });
    expect(result.ssh).toEqual([
      { host: `127.0.0.1:${lab.bastionPort}`, fingerprint: expect.stringMatching(FINGERPRINT), firstSeen: true },
      // The same server as the direct route, under the name the bastion knows it by.
      { host: "sshd:22", fingerprint: direct.ssh[0].fingerprint, firstSeen: true },
    ]);
  }, 30_000);

  it("logs in with a key file, with its passphrase or none, and says which is missing", async () => {
    const plain = await test("postgres", pgUrl(), alice({ auth: "keyFile", password: undefined, keyFile: lab.key }), withCa());
    expect(plain).toMatchObject({ ok: true });
    const locked = alice({ auth: "keyFile", password: undefined, keyFile: lab.keyWithPassphrase });
    expect(await test("postgres", pgUrl(), { ...locked, passphrase: KEY_PASSPHRASE }, withCa())).toMatchObject({ ok: true });

    const none = await test("postgres", pgUrl(), locked, withCa());
    expect(none).toMatchObject({ ok: false, error: "The key file is protected by a passphrase." });
    expect(none.details).toContain("Enter it in Key file passphrase.");
    const wrong = await test("postgres", pgUrl(), { ...locked, passphrase: "not-the-passphrase" }, withCa());
    expect(wrong).toMatchObject({ ok: false, error: "The key file's passphrase is wrong." });
    expect(JSON.stringify(wrong)).not.toContain("not-the-passphrase");
  }, 30_000);

  it("says the SSH server refused the login, and never repeats the password", async () => {
    const result = await test("postgres", pgUrl(), alice({ password: "wrong-password" }), withCa());
    expect(result).toMatchObject({ ok: false, error: `The SSH server 127.0.0.1:${lab.sshPort} refused alice's login with the password.` });
    expect(result.details).toContain(`SSH: alice@127.0.0.1:${lab.sshPort} with password`);
    expect(JSON.stringify(result)).not.toContain("wrong-password");
  }, 30_000);

  it("gives OpenSSH's reason when the SSH server cannot reach the database", async () => {
    const refused = await test("postgres", `postgres://app:${PG_PASSWORD}@pg:5999/shop`, alice());
    expect(refused).toMatchObject({ ok: false, error: "The SSH server reached pg:5999, but nothing accepts connections there (Connection refused)." });

    const prohibited = await test("postgres", pgUrl("pg", ""), alice({ user: "bob" }));
    expect(prohibited).toMatchObject({ ok: false, error: "The SSH server does not allow connections to pg:5432 (administratively prohibited)." });
    expect(prohibited.details).toContain("AllowTcpForwarding or PermitOpen");

    const unknown = await test("postgres", `postgres://app:${PG_PASSWORD}@nosuchhost.invalid:5432/shop`, alice());
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toStartWith("The SSH server could not connect to nosuchhost.invalid:5432: ");
    expect(openSshTunnelCount()).toBe(0);
  }, 60_000);

  it("checks MariaDB's certificate through the tunnel, by name and by IP address", async () => {
    const byName = await test("mariadb", mariadbUrl("mariadb"), alice(), withCa());
    expect(byName).toMatchObject({ ok: true, target: "mariadb:3306", tls: "TLSv1.3", version: expect.stringMatching(/^MariaDB 11\./) });
    // mysql2 names no server to TLS for an IP address; the identity check falls back to the stream's host.
    const byIp = await test("mariadb", mariadbUrl(lab.mariadbIp), alice(), withCa());
    expect(byIp).toMatchObject({ ok: true, tls: "TLSv1.3" });

    const other = await test("mariadb", mariadbUrl("mariadb-other"), alice(), withCa());
    expect(other.ok).toBe(false);
    expect(other.error).toContain("Host: mariadb-other. is not in the cert's altnames");
    const noCa = await test("mariadb", mariadbUrl("mariadb"), alice());
    expect(noCa.ok).toBe(false);
    expect(noCa.error).toMatch(/certificate/);
  }, 60_000);

  it("closes the tunnel, and the database sessions behind it, on Disconnect", async () => {
    const id = await save("through ssh", "postgres", { connectionString: pgUrl(), ssh: alice(), ssl: withCa() });
    const tables = await call("GET", `/db/connections/${id}/tables`);
    expect({ status: tables.status, body: tables.json }).toMatchObject({ status: 200 });
    expect(await tunnelledSessions()).toBeGreaterThan(0);
    expect(openSshTunnelCount()).toBe(1);

    expect((await call("POST", `/db/connections/${id}/disconnect`)).status).toBe(200);
    expect(openSshTunnelCount()).toBe(0);
    await until("the tunnelled sessions ended", async () => (await tunnelledSessions()) === 0, 5_000);
  }, 30_000);

  it("keeps every secret out of the edit form, encrypted on disk, and still usable", async () => {
    const withPassword = await save("secrets: password", "postgres", {
      // A key password is kept only with a key file to open. Only saved here, so the file is never read.
      connectionString: pgUrl(), ssh: alice(), ssl: { ca: lab.ca, key: join(dirname(lab.ca), "client.key"), keyPassword: "ssl-key-secret" },
    });
    const withKey = await save("secrets: key", "postgres", {
      connectionString: pgUrl(), ssh: alice({ auth: "keyFile", password: undefined, keyFile: lab.keyWithPassphrase, passphrase: KEY_PASSPHRASE }), ssl: withCa(),
    });
    for (const id of [withPassword, withKey]) {
      const edit = await call("GET", `/db/connections/${id}/config`);
      expect(edit.status).toBe(200);
      for (const secret of ["secret", PG_PASSWORD]) expect(JSON.stringify(edit.json)).not.toContain(secret);
      for (const secret of ["\"secret\"", KEY_PASSPHRASE, PG_PASSWORD, "ssl-key-secret"]) expect(getConnectionById(id)!.connection_config).not.toContain(secret);
    }
    const byPassword = (await call("GET", `/db/connections/${withPassword}/config`)).json.data;
    expect(byPassword).toMatchObject({ hasPassword: true, ssh: { hasPassword: true, hasPassphrase: false }, ssl: { hasKeyPassword: true } });
    const byKey = (await call("GET", `/db/connections/${withKey}/config`)).json.data;
    expect(byKey).toMatchObject({ hasPassword: true, ssh: { hasPassword: false, hasPassphrase: true } });

    // The form sends back what /config gave it, with no secret in it: the saved ones stand in.
    const { hasPassword: _p, hasPassphrase: _k, ...ssh } = byKey.ssh;
    const again = await call("POST", "/db/test", {
      type: "postgres", connectionId: withKey,
      connectionConfig: { type: "postgres", connectionString: byKey.connectionString, ssh, ssl: withCa(), keepPassword: true },
    });
    expect(again.json.data).toMatchObject({ ok: true, tls: "TLSv1.3" });
  }, 30_000);

  it("still connects with an old URL that asks for TLS and has no tunnel or files", async () => {
    const url = `postgres://app:${PG_PASSWORD}@127.0.0.1:${lab.pgPort}/shop?sslmode=require`;
    expect(await test("postgres", url)).toMatchObject({ ok: true, tls: "TLSv1.3" });
    const id = await save("old url", "postgres", { connectionString: url });
    const saved = await call("POST", `/db/connections/${id}/test`);
    expect(saved.json.data).toMatchObject({ ok: true });
  }, 30_000);

  it("runs a CLI query through the tunnel, and the CLI exits once it has answered", async () => {
    await save("cli-through-ssh", "postgres", { connectionString: pgUrl(), ssh: alice(), ssl: withCa() });
    const started = performance.now();
    const proc = Bun.spawn(["bun", join(REPO, "src/index.ts"), "db", "query", "cli-through-ssh", "select 1 as one", "--json"], {
      cwd: REPO, env: { ...process.env, PPM_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [out, errText, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, errText }).toMatchObject({ code: 0 });
    // Well inside the minute an idle tunnel would otherwise stay open for.
    expect(performance.now() - started).toBeLessThan(20_000);
    // The banner comes first on stdout, --json or not.
    expect(JSON.parse(out.slice(out.indexOf("{"))).rows).toEqual([{ one: 1 }]);
  }, 40_000);

  it("refuses a server whose host key changed, until its entry is removed", async () => {
    await lab.rekeySshd();
    const changed = await test("postgres", pgUrl(), alice(), withCa());
    expect(changed.ok).toBe(false);
    expect(changed.error).toStartWith(`The SSH server 127.0.0.1:${lab.sshPort} showed a different host key (SHA256:`);
    expect(changed.details).toContain(`delete ${knownHostsPath()}, line`);

    rmSync(knownHostsPath());
    const trusted = await test("postgres", pgUrl(), alice(), withCa());
    expect(trusted).toMatchObject({ ok: true });
    expect(trusted.ssh).toEqual([{ host: `127.0.0.1:${lab.sshPort}`, fingerprint: expect.stringMatching(FINGERPRINT), firstSeen: true }]);
  }, 30_000);
});
