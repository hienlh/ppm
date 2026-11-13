/**
 * Picking the PPM server that holds a database: one live endpoint file is that server; several
 * need PPM_INSTANCE_ID (or --instance); a stale file is ignored; with none, the database counts as
 * free only when nothing answers on its port. A server is used only after it proves it holds the
 * token, and only on a loopback URL.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverServer, loopbackUrl } from "../../../src/cli/utils/server-discovery.ts";
import { endpointBaseUrl, endpointFilePath, type ServerEndpoint } from "../../../src/services/server-endpoint-file.ts";
import { helloProof } from "../../../src/services/cli-hello-proof.ts";

const TOKEN = "the-token";
const DB = "/x/ppm.dev.db";
let dir: string;
const servers: ReturnType<typeof Bun.serve>[] = [];

/**
 * A server answering the identity check the way a PPM holding `token` would: for the port it is
 * reached on, or for `proofPort` (a supervised server's own listener answers for its main port).
 */
function helloServer(instanceId: string, token = TOKEN, proofPort?: number): number {
  const s = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const nonce = url.searchParams.get("nonce") ?? "";
      const proof = helloProof(token, nonce, instanceId, proofPort ?? Number(url.port));
      return Response.json({ ok: true, data: { instanceId, dbFile: "ppm.dev.db", proof } });
    },
  });
  servers.push(s);
  return s.port;
}

/** A port nothing listens on any more. */
function closedPort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = s.port;
  s.stop(true);
  return port;
}

function writeEndpoint(pid: number, instanceId: string, baseUrl: string, helloPort?: number): void {
  const e: ServerEndpoint = { pid, baseUrl, instanceId, dbFile: "ppm.dev.db", version: "t", startedAt: "", ...(helloPort ? { helloPort } : {}) };
  writeFileSync(endpointFilePath(DB, pid, dir), JSON.stringify(e));
}

const input = (extra: Partial<Parameters<typeof discoverServer>[0]> = {}) => ({
  dbFile: DB, profile: "dev", token: TOKEN, configPort: 1, dir, supervisorStatus: {}, portAnswers: async () => false, ...extra,
});

async function deadPid(): Promise<number> {
  const p = Bun.spawn([process.execPath, "-e", "0"]);
  await p.exited;
  return p.pid;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ppm-discovery-")); });
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("discoverServer", () => {
  it("uses the one live server after it proves the token", async () => {
    writeEndpoint(process.pid, "a", `http://127.0.0.1:${helloServer("a")}`);
    const d = await discoverServer(input());
    expect(d.kind).toBe("server");
    expect(d.kind === "server" && d.endpoint.instanceId).toBe("a");
  });

  it("refuses when two live servers share the database, naming their pids", async () => {
    writeEndpoint(process.pid, "a", `http://127.0.0.1:${helloServer("a")}`);
    writeEndpoint(process.ppid, "b", `http://127.0.0.1:${helloServer("b")}`);
    const d = await discoverServer(input());
    expect(d.kind).toBe("refused");
    expect(d.kind === "refused" && d.reason).toContain(`2 PPM servers share ppm.dev.db`);
    expect(d.kind === "refused" && d.reason).toContain(String(process.ppid));
  });

  it("picks the one PPM_INSTANCE_ID names among several, and --instance must match", async () => {
    writeEndpoint(process.pid, "a", `http://127.0.0.1:${helloServer("a")}`);
    writeEndpoint(process.ppid, "b", `http://127.0.0.1:${helloServer("b")}`);
    const d = await discoverServer(input({ preferredInstance: "b" }));
    expect(d.kind === "server" && d.endpoint.pid).toBe(process.ppid);
    const byPid = await discoverServer(input({ strictInstance: String(process.pid) }));
    expect(byPid.kind === "server" && byPid.endpoint.instanceId).toBe("a");
    expect((await discoverServer(input({ strictInstance: "nope" }))).kind).toBe("refused");
  });

  it("ignores a stale file, and then finds the database free when its port is closed", async () => {
    writeEndpoint(await deadPid(), "gone", "http://127.0.0.1:9");
    expect((await discoverServer(input())).kind).toBe("none");
    const busy = await discoverServer(input({ portAnswers: async () => true }));
    expect(busy.kind === "refused" && busy.reason).toContain("Something is listening on port 1");
  });

  it("treats a live pid's file whose port refuses connections as stale: removed, and the database found free", async () => {
    // A server killed without removing its file, its pid since reused by an unrelated process.
    writeEndpoint(process.pid, "gone", `http://127.0.0.1:${closedPort()}`);
    expect((await discoverServer(input())).kind).toBe("none");
    expect(existsSync(endpointFilePath(DB, process.pid, dir))).toBe(false);
    writeEndpoint(process.pid, "gone", `http://127.0.0.1:${closedPort()}`);
    const busy = await discoverServer(input({ portAnswers: async () => true }));
    expect(busy.kind === "refused" && busy.reason).toContain("Something is listening on port 1");
  });

  it("moves past a stale file to the one live server beside it", async () => {
    writeEndpoint(process.pid, "gone", `http://127.0.0.1:${closedPort()}`);
    writeEndpoint(process.ppid, "b", `http://127.0.0.1:${helloServer("b")}`);
    const d = await discoverServer(input());
    expect(d.kind === "server" && d.endpoint.instanceId).toBe("b");
  });

  it("asks a supervised server on its identity-check port, for the main port the token goes to", async () => {
    const main = closedPort();
    writeEndpoint(process.pid, "a", `http://127.0.0.1:${main}`, helloServer("a", TOKEN, main));
    const d = await discoverServer(input());
    expect(d.kind === "server" && d.endpoint.baseUrl).toBe(`http://127.0.0.1:${main}`);
    // A proof made for any other port (here the listener's own) is not one for the main port.
    rmSync(endpointFilePath(DB, process.pid, dir));
    writeEndpoint(process.pid, "a", `http://127.0.0.1:${main}`, helloServer("a"));
    const relayed = await discoverServer(input());
    expect(relayed.kind === "refused" && relayed.reason).toContain("did not prove");
  });

  it("does not count the database free while a supervisor of the same profile is alive", async () => {
    const d = await discoverServer(input({ supervisorStatus: { supervisorPid: process.pid, profile: "dev" } }));
    expect(d.kind).toBe("refused");
    const other = await discoverServer(input({ supervisorStatus: { supervisorPid: process.pid, profile: null } }));
    expect(other.kind).toBe("none");
  });

  it("refuses a server whose proof does not check out, or one off loopback", async () => {
    writeEndpoint(process.pid, "a", `http://127.0.0.1:${helloServer("a", "another-token")}`);
    const d = await discoverServer(input());
    expect(d.kind === "refused" && d.reason).toContain("did not prove");
    rmSync(endpointFilePath(DB, process.pid, dir));
    writeEndpoint(process.pid, "a", "http://192.168.1.5:8080");
    expect((await discoverServer(input())).kind).toBe("refused");
  });
});

describe("endpoint URLs", () => {
  it("reach a wildcard or loopback bind on 127.0.0.1, and keep a specific address", () => {
    expect(endpointBaseUrl(8080, "0.0.0.0")).toBe("http://127.0.0.1:8080");
    expect(endpointBaseUrl(8080, "::")).toBe("http://127.0.0.1:8080");
    expect(endpointBaseUrl(8080, "::ffff:127.0.0.1")).toBe("http://127.0.0.1:8080");
    expect(endpointBaseUrl(8080, "::1")).toBe("http://[::1]:8080");
    expect(endpointBaseUrl(8080, "192.168.1.5")).toBe("http://192.168.1.5:8080");
  });

  it("accept only plain-http loopback URLs with no credentials", () => {
    expect(loopbackUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(loopbackUrl("http://127.3.0.1:8080/")).toBe("http://127.3.0.1:8080");
    expect(loopbackUrl("http://[::1]:8080")).toBe("http://[::1]:8080");
    for (const bad of ["https://127.0.0.1:8080", "http://u:p@127.0.0.1:8080", "http://example.com:80", "http://127.0.0.1", "http://127.0.0.1:1/x", "nonsense"]) {
      expect({ bad, url: loopbackUrl(bad) }).toEqual({ bad, url: null });
    }
  });
});
