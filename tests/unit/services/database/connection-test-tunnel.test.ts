/**
 * The connection form's Test through an SSH tunnel, against ssh2's own server in this process and
 * both drivers installed the way Settings installs them. What is pinned: the tunnel's failure is
 * the message the form shows — not the driver's rewording of it, and not a timeout — its hint and
 * the tunnel's route are in the details, no secret comes back, and the test's own SSH session is
 * closed whatever happened.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyingRunner } from "../../../helpers/db-driver-offline-install.ts";
import { closedPort, startEchoServer, startSshTestServer, type SshTestServer } from "../../../helpers/ssh-test-server.ts";
import { _resetPpmDir } from "../../../../src/services/ppm-dir.ts";
import { serviceConnectionString, takeEndpoint } from "../../../../src/services/database/connection-endpoint.ts";
import { runConnectionTest } from "../../../../src/services/database/connection-test.ts";
import { installDbDriver } from "../../../../src/services/database/drivers/db-driver-install.ts";
import { unloadDbDriver } from "../../../../src/services/database/drivers/db-driver-loader.ts";
import { initAdapters } from "../../../../src/services/database/init-adapters.ts";
import { closeAllSshTunnels, openSshChannel, openSshTunnelCount } from "../../../../src/services/database/ssh-tunnel.ts";
import type { DbTestResult, StoredConnectionConfig } from "../../../../src/shared/db-connection-config.ts";

initAdapters();

const originalPpmHome = process.env.PPM_HOME;
const ppmHome = mkdtempSync(join(tmpdir(), "ppm-connection-test-tunnel-"));
const servers: SshTestServer[] = [];

beforeAll(async () => {
  process.env.PPM_HOME = ppmHome;
  _resetPpmDir();
  await Promise.all([unloadDbDriver("ssh"), unloadDbDriver("mysql")]);
  await installDbDriver("ssh", { run: copyingRunner("ssh") });
  await installDbDriver("mysql", { run: copyingRunner("mysql") });
});

afterEach(async () => {
  closeAllSshTunnels();
  for (const s of servers.splice(0)) await s.close();
});

afterAll(async () => {
  await Promise.all([unloadDbDriver("ssh"), unloadDbDriver("mysql")]);
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
  rmSync(ppmHome, { recursive: true, force: true });
});

async function sshServer(): Promise<SshTestServer> {
  const s = await startSshTestServer();
  servers.push(s);
  return s;
}

function failed(result: DbTestResult): Extract<DbTestResult, { ok: false }> {
  if (result.ok) throw new Error("expected the test to fail");
  return result;
}

const engines = [
  { type: "postgres", url: (port: number) => `postgres://app:dbsecret1@127.0.0.1:${port}/shop` },
  { type: "mysql", url: (port: number) => `mysql://root:dbsecret1@127.0.0.1:${port}/shop` },
] as const;

for (const engine of engines) {
  describe(`${engine.type} through a tunnel`, () => {
    it("says the SSH server refused the login, with what to check", async () => {
      const s = await sshServer();
      const config = {
        type: engine.type, connectionString: engine.url(5432),
        ssh: { enabled: true, host: "127.0.0.1", port: s.port, auth: "password", user: "alice", password: "wrongpass" },
      } as StoredConnectionConfig;
      const result = failed(await runConnectionTest(config));
      expect(result.error).toBe(`The SSH server 127.0.0.1:${s.port} refused alice's login with the password.`);
      expect(result.details.split("\n")).toContain("Check the login and the credentials on the SSH Tunnel tab.");
      expect(result.details).toContain(`SSH: alice@127.0.0.1:${s.port} with password`);
      expect(JSON.stringify(result)).not.toContain("wrongpass");
      expect(JSON.stringify(result)).not.toContain("dbsecret1");
      expect(openSshTunnelCount()).toBe(0);
    });

    it("says the SSH server could not reach the database, and closes its session", async () => {
      const s = await sshServer();
      const db = await closedPort();
      const config = {
        type: engine.type, connectionString: engine.url(db),
        ssh: { enabled: true, host: "127.0.0.1", port: s.port, auth: "password", user: "alice", password: "secret" },
      } as StoredConnectionConfig;
      const result = failed(await runConnectionTest(config));
      // ssh2's server gives only the RFC's reason code; OpenSSH adds "Connection refused".
      expect(result.error).toBe(`The SSH server could not connect to 127.0.0.1:${db}: connect failed`);
      expect(result.details).toContain("The database's host and port are as the SSH server sees them: often localhost.");
      expect(result.details).toContain(`Server: 127.0.0.1:${db} (${engine.type === "postgres" ? "PostgreSQL" : "MySQL"}), as the SSH server sees it`);
      expect(result.elapsedMs).toBeLessThan(5000);
      expect(openSshTunnelCount()).toBe(0);
      // The client's goodbye reaches the SSH server a moment later.
      const until = Date.now() + 3000;
      while (s.open > 0 && Date.now() < until) await Bun.sleep(10);
      expect(s.open).toBe(0);
    });
  });
}

describe("a test beside an open connection", () => {
  it("logs in on its own and leaves the connection's tunnel open", async () => {
    const s = await sshServer();
    const echo = await startEchoServer();
    try {
      // A saved connection with a grid open: its pool holds a channel through the tunnel.
      const saved = {
        type: "postgres", connectionString: `postgres://app@127.0.0.1:${echo.port}/shop`,
        ssh: { enabled: true, host: "127.0.0.1", port: s.port, auth: "password", user: "alice", password: "secret" },
      } as StoredConnectionConfig;
      const { endpoint } = takeEndpoint(serviceConnectionString(saved));
      const channel = await openSshChannel(endpoint!.id, endpoint!.profile.ssh!, endpoint!.target);

      // The same tunnel, tested from the edit form with the database moved: the test is its own
      // login, and closing it afterwards closes nothing else.
      failed(await runConnectionTest({ ...saved, connectionString: `postgres://app@127.0.0.1:${await closedPort()}/shop` }));
      expect(s.connections).toBe(2);
      expect(openSshTunnelCount()).toBe(1);
      expect(channel.readyState).toBe("open");
    } finally {
      await echo.close();
    }
  });
});
