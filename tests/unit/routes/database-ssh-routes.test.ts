/**
 * The routes' side of SSH tunnels: the SSH agent line on the SSH Tunnel tab, the 424 that draws
 * the tunnel driver's Install button, and a connection's tunnel closed whenever what opened it is
 * gone — Disconnect, an edit of its settings, a deletion — and kept when an edit changed nothing
 * it depends on, or when what is gone is a Duplicate of the connection with the same settings.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { copyingRunner } from "../../helpers/db-driver-offline-install.ts";
import { closedPort, startEchoServer, startSshTestServer, type SshTestServer } from "../../helpers/ssh-test-server.ts";
import { getConnectionById, openTestDb, setDb } from "../../../src/services/db.service.ts";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { serviceConnectionString, takeEndpoint, type EndpointConfig } from "../../../src/services/database/connection-endpoint.ts";
import { installDbDriver } from "../../../src/services/database/drivers/db-driver-install.ts";
import { unloadDbDriver } from "../../../src/services/database/drivers/db-driver-loader.ts";
import { initAdapters } from "../../../src/services/database/init-adapters.ts";
import { closeAllSshTunnels, localSshUser, openSshChannel, openSshTunnelCount } from "../../../src/services/database/ssh-tunnel.ts";
import { databaseRoutes } from "../../../src/server/routes/database.ts";
import { connConfig } from "../../../src/server/routes/database-route-helpers.ts";
import { DB_DRIVER_MISSING } from "../../../src/shared/db-drivers.ts";

const originalPpmHome = process.env.PPM_HOME;
const originalAuthSock = process.env.SSH_AUTH_SOCK;
const temps: string[] = [];
const app = new Hono().route("/db", databaseRoutes);

initAdapters();

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ppm-db-ssh-routes-"));
  temps.push(dir);
  process.env.PPM_HOME = dir;
  _resetPpmDir();
  // The loader keeps a driver for the life of the process; this directory has none.
  await unloadDbDriver("ssh");
  setDb(openTestDb());
});

afterEach(() => {
  closeAllSshTunnels();
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  if (originalAuthSock === undefined) delete process.env.SSH_AUTH_SOCK;
  else process.env.SSH_AUTH_SOCK = originalAuthSock;
  _resetPpmDir();
});

afterAll(async () => {
  await Promise.all([unloadDbDriver("ssh"), unloadDbDriver("mysql")]);
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function addConnection(connectionConfig: Record<string, unknown>): Promise<number> {
  const type = connectionConfig.type;
  const { status, json } = await call("POST", "/db/connections", { type, name: `${type}-${temps.length}-${Math.random()}`, connectionConfig });
  expect(status).toBe(201);
  return json.data.id;
}

describe.skipIf(process.platform === "win32")("GET /db/ssh/agent", () => {
  it("names the agent's socket when there is one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ppm-db-ssh-agent-"));
    temps.push(dir);
    const sock = join(dir, "agent.sock");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      process.env.SSH_AUTH_SOCK = sock;
      expect(await call("GET", "/db/ssh/agent")).toEqual({ status: 200, json: { ok: true, data: { found: true, socket: sock, user: localSshUser() } } });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("a connection through a tunnel while the SSH driver is missing", () => {
  const tunnel = { enabled: true, host: "ssh.example.com", auth: "password", user: "deploy", password: "pw" };
  const expectMissing = ({ status, json }: { status: number; json: any }) => {
    expect(status).toBe(424);
    expect(json).toMatchObject({ ok: false, code: DB_DRIVER_MISSING, driver: { id: "ssh", displayName: "SSH tunnel" } });
  };

  it("answers 424 naming the SSH driver, wherever the database is needed", async () => {
    const id = await addConnection({ type: "postgres", connectionString: "postgres://app@localhost/shop", ssh: tunnel });
    expectMissing(await call("GET", `/db/connections/${id}/tables`));
    expectMissing(await call("POST", `/db/connections/${id}/query`, { sql: "SELECT 1" }));
    expectMissing(await call("POST", `/db/connections/${id}/test`));
    expectMissing(await call("POST", "/db/test", { type: "postgres", connectionConfig: { type: "postgres", connectionString: "postgres://h/db", ssh: tunnel } }));
    // Its own record needs no driver: the form is how the tunnel gets turned off.
    expect((await call("GET", `/db/connections/${id}/config`)).status).toBe(200);
    expect((await call("POST", `/db/connections/${id}/disconnect`)).status).toBe(200);
  });

  it("needs no SSH driver with the tunnel unticked", async () => {
    const port = await closedPort();
    const { status, json } = await call("POST", "/db/test", {
      type: "postgres", connectionConfig: { type: "postgres", connectionString: `postgres://app@127.0.0.1:${port}/shop`, ssh: { ...tunnel, enabled: false } },
    });
    expect(status).toBe(200);
    expect(json.data).toMatchObject({ ok: false, error: expect.stringContaining("ECONNREFUSED") });
  });
});

describe("closing a connection's tunnel", () => {
  let ssh: SshTestServer;
  let echo: Awaited<ReturnType<typeof startEchoServer>>;

  beforeEach(async () => {
    await installDbDriver("ssh", { run: copyingRunner("ssh") });
    await installDbDriver("mysql", { run: copyingRunner("mysql") });
    ssh = await startSshTestServer();
    echo = await startEchoServer();
  });

  afterEach(async () => {
    closeAllSshTunnels();
    await ssh.close();
    await echo.close();
  });

  /** A channel through connection `id`'s tunnel, as its pool holds one: its config as every route builds it. */
  async function openTunnel(id: number): Promise<void> {
    const { endpoint } = takeEndpoint(serviceConnectionString(connConfig(getConnectionById(id)!) as EndpointConfig));
    await openSshChannel(endpoint!.id, endpoint!.profile.ssh!, endpoint!.target);
  }

  /** A saved connection with a pool open. */
  async function openConnection(type: "postgres" | "mysql" = "postgres"): Promise<{ id: number; input: Record<string, unknown> }> {
    const input = {
      type, connectionString: `${type}://app@127.0.0.1:${echo.port}/shop`,
      ssh: { enabled: true, host: "127.0.0.1", port: ssh.port, auth: "password", user: "alice", password: "secret" },
    };
    const id = await addConnection(input);
    await openTunnel(id);
    expect(openSshTunnelCount()).toBe(1);
    return { id, input };
  }

  for (const type of ["postgres", "mysql"] as const) {
    it(`closes it on Disconnect (${type})`, async () => {
      const { id } = await openConnection(type);
      expect((await call("POST", `/db/connections/${id}/disconnect`)).status).toBe(200);
      expect(openSshTunnelCount()).toBe(0);
    });
  }

  it("closes it when the connection is deleted", async () => {
    const { id } = await openConnection();
    expect((await call("DELETE", `/db/connections/${id}`)).status).toBe(200);
    expect(openSshTunnelCount()).toBe(0);
  });

  it("closes it when an edit changes the settings, and keeps it for a rename or an unchanged save", async () => {
    const { id, input } = await openConnection();
    expect((await call("PUT", `/db/connections/${id}`, { name: "renamed" })).status).toBe(200);
    // Saved again as the form sends it: the password left empty and kept.
    const { password: _password, ...withoutPassword } = input.ssh as Record<string, unknown>;
    expect((await call("PUT", `/db/connections/${id}`, { connectionConfig: { ...input, ssh: withoutPassword, keepPassword: true } })).status).toBe(200);
    expect(openSshTunnelCount()).toBe(1);

    const moved = { ...input, ssh: { ...(input.ssh as object), user: "bob" }, keepPassword: true };
    expect((await call("PUT", `/db/connections/${id}`, { connectionConfig: moved })).status).toBe(200);
    expect(openSshTunnelCount()).toBe(0);
  });

  it("keeps it open when a Duplicate with the same settings is disconnected, edited or deleted", async () => {
    const { id, input } = await openConnection();
    const { status, json } = await call("POST", `/db/connections/${id}/duplicate`);
    expect(status).toBe(201);
    const copy: number = json.data.id;
    await openTunnel(copy);
    // A session each: closing one must not end the queries running through the other.
    expect(openSshTunnelCount()).toBe(2);

    expect((await call("POST", `/db/connections/${copy}/disconnect`)).status).toBe(200);
    expect(openSshTunnelCount()).toBe(1);
    await openTunnel(copy);
    const moved = { ...input, ssh: { ...(input.ssh as object), user: "bob" }, keepPassword: true };
    expect((await call("PUT", `/db/connections/${copy}`, { connectionConfig: moved })).status).toBe(200);
    expect(openSshTunnelCount()).toBe(1);
    expect((await call("DELETE", `/db/connections/${copy}`)).status).toBe(200);
    expect(openSshTunnelCount()).toBe(1);

    expect((await call("POST", `/db/connections/${id}/disconnect`)).status).toBe(200);
    expect(openSshTunnelCount()).toBe(0);
  });
});
