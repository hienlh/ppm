import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  HttpError, ServerDownError, callServer, readStatusPort, resolveServer, type ServerConfig,
} from "../../../src/cli/utils/server-client.ts";

const dirs: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ppmDir(status?: unknown): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ppm-srvclient-"));
  dirs.push(dir);
  if (status !== undefined) writeFileSync(resolve(dir, "status.json"), typeof status === "string" ? status : JSON.stringify(status));
  return dir;
}

const config = (port: number, auth = { enabled: false, token: "" }): (() => Promise<ServerConfig>) => async () => ({ port, auth });

/** A stand-in PPM: answers health, and records what each other request carried. */
function fakeServer(handler: (req: Request) => Response | Promise<Response>) {
  const seen: Array<{ method: string; path: string; auth: string | null; body: string }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/health") return Response.json({ ok: true, data: { status: "running" } });
      seen.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization"), body: await req.text() });
      return handler(req);
    },
  });
  servers.push(server);
  return { port: server.port as number, seen };
}

describe("readStatusPort", () => {
  it("reads a valid port and ignores anything else", () => {
    expect(readStatusPort(ppmDir({ port: 3214 }))).toBe(3214);
    expect(readStatusPort(ppmDir())).toBeNull();
    expect(readStatusPort(ppmDir("{nope"))).toBeNull();
    expect(readStatusPort(ppmDir({ port: "3214" }))).toBeNull();
    expect(readStatusPort(ppmDir({ port: 70000 }))).toBeNull();
  });
});

describe("resolveServer", () => {
  it("prefers the supervisor's status.json port over the setting, always on 127.0.0.1", async () => {
    expect(await resolveServer(ppmDir({ port: 3214 }), config(8080))).toEqual({ baseUrl: "http://127.0.0.1:3214", token: null });
    expect(await resolveServer(ppmDir(), config(8081))).toEqual({ baseUrl: "http://127.0.0.1:8081", token: null });
  });

  it("sends the token only when auth is on", async () => {
    expect((await resolveServer(ppmDir(), config(1, { enabled: true, token: "t0k" }))).token).toBe("t0k");
    expect((await resolveServer(ppmDir(), config(1, { enabled: false, token: "t0k" }))).token).toBeNull();
  });
});

describe("callServer", () => {
  it("returns the envelope's data and sends the bearer token and JSON body", async () => {
    const { port, seen } = fakeServer(() => Response.json({ ok: true, data: { n: 1 } }));
    const data = await callServer<{ n: number }>("POST", "/api/x", { a: 1 }, { server: { baseUrl: `http://127.0.0.1:${port}`, token: "t0k" } });
    expect(data).toEqual({ n: 1 });
    expect(seen).toEqual([{ method: "POST", path: "/api/x", auth: "Bearer t0k", body: '{"a":1}' }]);
  });

  it("throws HttpError with the route's status, message and code", async () => {
    const { port } = fakeServer(() => Response.json({ ok: false, error: "No such command", code: "NOT_FOUND" }, { status: 404 }));
    const e = await callServer("POST", "/api/x", {}, { server: { baseUrl: `http://127.0.0.1:${port}`, token: null } }).catch((x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect([e.status, e.message, e.code]).toEqual([404, "No such command", "NOT_FOUND"]);
  });

  it("throws ServerDownError when nothing listens on the port", async () => {
    const { port } = fakeServer(() => new Response("x"));
    servers.splice(0).forEach((s) => s.stop(true));
    const e = await callServer("GET", "/api/x", undefined, { server: { baseUrl: `http://127.0.0.1:${port}`, token: null } }).catch((x) => x);
    expect(e).toBeInstanceOf(ServerDownError);
    expect(e.message).toBe("PPM server not running — start with `ppm start`");
  });
});
