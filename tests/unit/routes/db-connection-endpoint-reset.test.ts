/**
 * A saved secret belongs to where it was typed. An edit that points a connection at another
 * server, port, login or SSH host and types no new secret drops the saved ones — for every caller,
 * the connection form included — so the next Test never sends the old password to the new place.
 * Proven against a stand-in PostgreSQL server that asks for a cleartext password and records what
 * it is sent.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { decryptConfig, getConnectionById, openTestDb, setDb } from "../../../src/services/db.service.ts";
import { _resetPpmDir } from "../../../src/services/ppm-dir.ts";
import { initAdapters } from "../../../src/services/database/init-adapters.ts";
import { databaseRoutes } from "../../../src/server/routes/database.ts";
import { ANNOUNCE_DB_CONNECTIONS_ENV_KEY } from "../../../src/server/routes/database-connections-broadcast.ts";
import { dropCarriedSecrets, endpointChanged } from "../../../src/services/database/connection-endpoint-reset.ts";

const SECRET = "hunter2-s3cret";
const originalPpmHome = process.env.PPM_HOME;
const temps: string[] = [];
const app = new Hono().route("/db", databaseRoutes);
const announced: string[] = [];

initAdapters();

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ppm-db-endpoint-reset-"));
  temps.push(dir);
  process.env.PPM_HOME = dir;
  _resetPpmDir();
  setDb(openTestDb());
});

afterEach(() => {
  if (originalPpmHome === undefined) delete process.env.PPM_HOME;
  else process.env.PPM_HOME = originalPpmHome;
  _resetPpmDir();
});

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(path, {
    method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  }, { [ANNOUNCE_DB_CONNECTIONS_ENV_KEY]: () => announced.push(`${method} ${path}`) });
  return { status: res.status, json: await res.json() };
}

const stored = (id: number) => decryptConfig(getConnectionById(id)!.connection_config) as Record<string, any>;

async function create(url: string, extra: Record<string, unknown> = {}): Promise<number> {
  const { status, json } = await call("POST", "/db/connections", { type: "postgres", name: `c-${crypto.randomUUID()}`, connectionConfig: { type: "postgres", connectionString: url, ...extra } });
  expect({ status, error: json.error }).toEqual({ status: 201, error: undefined });
  return json.data.id;
}

/** A stand-in PostgreSQL server: it asks for a cleartext password, records every byte, and refuses. */
function fakePostgres() {
  const received: Buffer[] = [];
  const authCleartext = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 3]);
  const fields = Buffer.from("SFATAL\0VFATAL\0C28P01\0Mpassword authentication failed\0\0", "latin1");
  const header = Buffer.alloc(5);
  header.write("E", 0, "latin1");
  header.writeInt32BE(fields.length + 4, 1);
  const refusal = Buffer.concat([header, fields]);
  const server = Bun.listen<{ buf: Buffer; started: boolean }>({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(s) { s.data = { buf: Buffer.alloc(0), started: false }; },
      data(s, chunk) {
        received.push(Buffer.from(chunk));
        let buf = Buffer.concat([s.data.buf, Buffer.from(chunk)]);
        for (;;) {
          if (!s.data.started) {
            if (buf.length < 8 || buf.length < buf.readInt32BE(0)) break;
            const code = buf.readInt32BE(4);
            buf = buf.subarray(buf.readInt32BE(0));
            if (code === 80877103) { s.write("N"); continue; }
            s.data.started = true;
            s.write(authCleartext);
            continue;
          }
          if (buf.length < 5 || buf.length < buf.readInt32BE(1) + 1) break;
          const type = String.fromCharCode(buf[0]!);
          buf = buf.subarray(buf.readInt32BE(1) + 1);
          if (type === "p") { s.write(refusal); s.end(); }
        }
        s.data.buf = buf;
      },
    },
  });
  return { port: server.port, seen: () => Buffer.concat(received).toString("latin1"), stop: () => server.stop(true) };
}

describe("PUT /db/connections/:id after the endpoint changed", () => {
  it("sends the saved password to the same server, and never to a new one", async () => {
    const pg = fakePostgres();
    try {
      const id = await create(`postgres://app:${SECRET}@127.0.0.1:${pg.port}/shop`);
      // Another database on the same server keeps the password: it still goes where it was typed.
      const same = await call("PUT", `/db/connections/${id}`, { connectionConfig: { type: "postgres", connectionString: `postgres://app@127.0.0.1:${pg.port}/other`, keepPassword: true } });
      expect(same.json.data.secretsCleared).toBeUndefined();
      expect(stored(id).connectionString).toContain(SECRET);
      expect((await call("POST", `/db/connections/${id}/test`, {})).json.data.ok).toBe(false);
      expect(pg.seen()).toContain(SECRET);
    } finally {
      pg.stop();
    }

    const moved = fakePostgres();
    try {
      const id = await create(`postgres://app:${SECRET}@127.0.0.1:1/shop`);
      const put = await call("PUT", `/db/connections/${id}`, { connectionConfig: { type: "postgres", connectionString: `postgres://app@127.0.0.1:${moved.port}/shop`, keepPassword: true } });
      expect(put).toMatchObject({ status: 200, json: { data: { secretsCleared: ["password"] } } });
      expect(stored(id).connectionString).toBe(`postgres://app@127.0.0.1:${moved.port}/shop`);
      const test = await call("POST", `/db/connections/${id}/test`, {});
      expect(test.json.data).toMatchObject({ ok: false, error: expect.stringContaining("password authentication failed") });
      expect(moved.seen()).not.toContain(SECRET);
      // The server was reached and asked for a password: the test failed on authentication, not on the network.
      expect(moved.seen().length).toBeGreaterThan(0);
    } finally {
      moved.stop();
    }
  }, 40_000);

  it("keeps a password typed with the new endpoint, and drops one for a changed login", async () => {
    const id = await create(`postgres://app:${SECRET}@db.example.com/shop`);
    await call("PUT", `/db/connections/${id}`, { connectionConfig: { type: "postgres", connectionString: "postgres://app:fresh@db2.example.com/shop", keepPassword: true } });
    expect(stored(id).connectionString).toBe("postgres://app:fresh@db2.example.com/shop");
    const put = await call("PUT", `/db/connections/${id}`, { connectionConfig: { type: "postgres", connectionString: "postgres://admin@db2.example.com/shop", keepPassword: true } });
    expect(put.json.data.secretsCleared).toEqual(["password"]);
    expect(stored(id).connectionString).toBe("postgres://admin@db2.example.com/shop");
  });

  it("drops the URL's and the tunnel's secrets when only the SSH host changes", async () => {
    const id = await create(`postgres://app:${SECRET}@localhost/shop`, { ssh: { enabled: true, host: "jump.example.com", auth: "password", user: "deploy", password: "ssh-secret" } });
    const put = await call("PUT", `/db/connections/${id}`, { connectionConfig: { type: "postgres", ssh: { enabled: true, host: "evil.example.com", auth: "password", user: "deploy" }, keepPassword: true } });
    expect(put.json.data.secretsCleared).toEqual(["password", "SSH password"]);
    expect(stored(id)).toMatchObject({ connectionString: "postgres://app@localhost/shop", ssh: { host: "evil.example.com" } });
    expect(stored(id).ssh.password).toBeUndefined();
    expect(announced.length).toBeGreaterThan(0);
  });

  it("does the same for the form's Test of an edit not yet saved", () => {
    const before = { type: "postgres" as const, connectionString: `postgres://app:${SECRET}@a.example.com/shop` };
    const after = { type: "postgres" as const, connectionString: `postgres://app:${SECRET}@b.example.com/shop` };
    expect(endpointChanged(before, after)).toBe(true);
    expect(dropCarriedSecrets(before, after, { connectionString: "postgres://app@b.example.com/shop", keepPassword: true }).config)
      .toEqual({ type: "postgres", connectionString: "postgres://app@b.example.com/shop" });
    // The default port spelled out is the same place.
    expect(endpointChanged(before, { ...before, connectionString: `postgres://app:${SECRET}@a.example.com:5432/shop` })).toBe(false);
  });
});
